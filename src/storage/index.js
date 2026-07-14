import { toUrlRecord } from './normalize.js';

/**
 * Milestone 3 存储层：把采集结果落进 SQLite，并判断新增 URL。
 *
 * 准入契约（与 collector.js 的 Milestone 3 强制接口契约一致）：只有
 * status==="success" && complete===true && truncated===false && pageUrlCount>0
 * 的结果才允许写入正式 URL 历史（seen_urls / added_urls / baseline）。
 * 其余结果由 recordRejectedSiteResult 只记录运行诊断，不碰历史。
 */

/** 判断一个采集结果是否允许写入正式 URL 历史。 */
export function isAdmissible(result) {
  return (
    result &&
    result.status === 'success' &&
    result.complete === true &&
    result.truncated === false &&
    Number(result.pageUrlCount) > 0
  );
}

/** 新建一条整体运行记录（crawl_runs），返回 runId。 */
export function createCrawlRun(db, { runId, startedAt }) {
  db.prepare(
    `INSERT INTO crawl_runs (run_id, started_at, status) VALUES (?, ?, 'running')`,
  ).run(runId, startedAt);
  return runId;
}

/** 收尾整体运行记录，写入汇总统计。 */
export function finishCrawlRun(db, { runId, finishedAt, status, stats, errorSummary }) {
  db.prepare(
    `UPDATE crawl_runs SET
       finished_at = @finished_at,
       status = @status,
       sites_total = @sites_total,
       sites_success = @sites_success,
       sites_partial = @sites_partial,
       sites_failed = @sites_failed,
       baseline_site_count = @baseline_site_count,
       baseline_url_count = @baseline_url_count,
       added_url_count = @added_url_count,
       missing_url_count = @missing_url_count,
       consecutive_missing_count = @consecutive_missing_count,
       restored_url_count = @restored_url_count,
       error_summary = @error_summary
     WHERE run_id = @run_id`,
  ).run({
    run_id: runId,
    finished_at: finishedAt,
    status,
    sites_total: stats.sitesTotal || 0,
    sites_success: stats.sitesSuccess || 0,
    sites_partial: stats.sitesPartial || 0,
    sites_failed: stats.sitesFailed || 0,
    baseline_site_count: stats.baselineSiteCount || 0,
    baseline_url_count: stats.baselineUrlCount || 0,
    added_url_count: stats.addedUrlCount || 0,
    missing_url_count: stats.missingUrlCount || 0,
    consecutive_missing_count: stats.consecutiveMissingCount || 0,
    restored_url_count: stats.restoredUrlCount || 0,
    error_summary: errorSummary || null,
  });
}

/**
 * 在单个 SQLite 事务里持久化一个"完整成功"的站点采集结果。
 *
 * 事务内顺序：写 site_crawl_run → upsert sitemap_endpoints → 查 baseline 状态
 * → upsert seen_urls → 写 added_urls → 更新 sites 最后成功状态。任一步骤抛错
 * 都会回滚整个站点事务，不留下半写入的 seen_urls / added_urls。
 *
 * 网络采集必须在调用本函数之前完成——本函数只做短事务写库。
 *
 * @param hooks 测试注入用；hooks.afterSeenUrls() 在写完 seen_urls、写 added_urls
 *              之前被调用，用于验证中途失败能整体回滚。
 * @returns { isBaseline, addedCount, pageUrlCount, newSeenCount }
 */
export function persistCompleteSiteResult(db, { runId, site, result, now, hooks = {} }) {
  if (!isAdmissible(result)) {
    throw new Error('persistCompleteSiteResult 只接受可准入的完整成功结果');
  }
  const ts = now || new Date().toISOString();
  const siteId = site.site_id;

  // 先在事务外把页面 URL 规范化 + 去重（按 url_hash），标准化是纯计算，不碰库。
  const records = dedupeByHash(
    result.pageUrls.map((u) => toUrlRecord(u)).filter(Boolean),
  );

  const tx = db.transaction(() => {
    // 1. baseline 状态：以 sites.baseline_completed_at 为权威标记。
    const siteRow = db.prepare('SELECT baseline_completed_at FROM sites WHERE site_id = ?').get(siteId);
    const isBaseline = !siteRow || !siteRow.baseline_completed_at;

    // 2. 本轮之前该站已见过的 url_hash 集合（用于判断哪些是新增）。
    const existingHashes = new Set(
      db.prepare('SELECT url_hash FROM seen_urls WHERE site_id = ?').all(siteId).map((r) => r.url_hash),
    );

    // 3. upsert sitemap_endpoints（成功处理过的 Endpoint）。
    upsertEndpoints(db, siteId, result.processedSitemaps || [], ts);

    // 4. upsert seen_urls。
    const upsertSeen = db.prepare(
      `INSERT INTO seen_urls (site_id, original_url, normalized_url, url_hash, first_seen_at, last_seen_at, first_run_id, last_run_id)
       VALUES (@site_id, @original_url, @normalized_url, @url_hash, @ts, @ts, @run_id, @run_id)
       ON CONFLICT(site_id, url_hash) DO UPDATE SET
         last_seen_at = @ts,
         last_run_id = @run_id`,
    );
    const newRecords = [];
    for (const rec of records) {
      if (!existingHashes.has(rec.urlHash)) newRecords.push(rec);
      upsertSeen.run({
        site_id: siteId,
        original_url: rec.originalUrl,
        normalized_url: rec.normalizedUrl,
        url_hash: rec.urlHash,
        ts,
        run_id: runId,
      });
    }

    // 测试注入点：验证"写完 seen_urls 后、写 added_urls 前"抛错能整体回滚。
    if (typeof hooks.afterSeenUrls === 'function') hooks.afterSeenUrls();

    // 5. added_urls：首次 baseline 不产生新增；后续运行把"本轮之前没见过"的记为新增。
    let addedCount = 0;
    if (!isBaseline) {
      const insertAdded = db.prepare(
        `INSERT OR IGNORE INTO added_urls (run_id, site_id, sitemap_url, original_url, normalized_url, url_hash, detected_at)
         VALUES (@run_id, @site_id, @sitemap_url, @original_url, @normalized_url, @url_hash, @ts)`,
      );
      for (const rec of newRecords) {
        const info = insertAdded.run({
          run_id: runId,
          site_id: siteId,
          sitemap_url: null, // M2 的 pageUrls 是扁平去重列表，暂不追踪逐 URL 来源 Sitemap
          original_url: rec.originalUrl,
          normalized_url: rec.normalizedUrl,
          url_hash: rec.urlHash,
          ts,
        });
        addedCount += info.changes;
      }
    }

    // 5b. Dashboard M4：URL 生命周期比较（missing / consecutive_missing /
    // restored）。首次 baseline 时 url_status 里该站还没有任何行，比较结果
    // 自然全为 0，不需要单独判断 isBaseline。恢复的 URL 一定已经在
    // seen_urls 里（否则不可能"曾经缺失"），所以上面的 existingHashes 判断
    // 已经天然把它们排除在 newRecords/added_urls 之外，这里不需要再额外
    // 处理"不能把 restored 算成 added"这条约束。
    const lifecycle = applyUrlLifecycle(db, { siteId, runId, records, ts });

    // 测试注入点：验证"写完 url_status/url_changes 后、写 site_crawl_runs
    // 前"抛错能把生命周期相关的写入也一并回滚。
    if (typeof hooks.afterLifecycle === 'function') hooks.afterLifecycle();

    // 6. 更新 sites 最后成功状态；首次成功时打上 baseline_completed_at。
    db.prepare(
      `UPDATE sites SET
         last_attempt_at = @ts,
         last_success_at = @ts,
         last_status = 'success',
         last_error = NULL,
         updated_at = @ts,
         baseline_completed_at = COALESCE(baseline_completed_at, @baseline_at)
       WHERE site_id = @site_id`,
    ).run({ site_id: siteId, ts, baseline_at: isBaseline ? ts : null });

    // 7. 站点级运行记录。
    insertSiteCrawlRun(db, {
      runId,
      site,
      result,
      addedCount: isBaseline ? 0 : addedCount,
      ts,
      errorSummary: null,
      missingCount: lifecycle.missingCount,
      consecutiveMissingCount: lifecycle.consecutiveMissingCount,
      restoredCount: lifecycle.restoredCount,
      comparisonPerformed: true,
    });

    return {
      isBaseline,
      addedCount: isBaseline ? 0 : addedCount,
      pageUrlCount: records.length,
      newSeenCount: newRecords.length,
      missingCount: lifecycle.missingCount,
      consecutiveMissingCount: lifecycle.consecutiveMissingCount,
      restoredCount: lifecycle.restoredCount,
      comparisonPerformed: true,
    };
  });

  return tx();
}

/**
 * 把"本轮之前 is_present=1 的 URL 集合"与"本轮实际拿到的完整 URL 集合"
 * 相比较，更新 url_status（当前状态）并在 url_changes（历史事件流水）里
 * 记录 missing / consecutive_missing / restored。
 *
 * 状态机（每个 url_hash 独立）：
 *   之前不存在于 url_status（第一次见到）        → 新建 is_present=1，不产生事件（由 added_urls 覆盖"新增"这个概念）
 *   之前 is_present=1，本轮仍在                  → 只更新 last_seen_run_id，不产生事件
 *   之前 is_present=1，本轮不在                  → missing（missing_streak: 0→1）
 *   之前 is_present=0，本轮又出现                → restored（missing_streak 清零）
 *   之前 is_present=0，本轮仍不在，streak 1→2    → consecutive_missing
 *   之前 is_present=0，本轮仍不在，streak ≥2→+1  → 只累加 streak，不再重复产生事件（避免连续多轮持续刷屏）
 *
 * 必须在调用方已经打开的同一个事务里执行（本函数自己不开事务）。
 */
function applyUrlLifecycle(db, { siteId, runId, records, ts }) {
  const statusRows = db
    .prepare(
      `SELECT url_hash, original_url, normalized_url, is_present, missing_streak
       FROM url_status WHERE site_id = ?`,
    )
    .all(siteId);
  const statusByHash = new Map(statusRows.map((r) => [r.url_hash, r]));
  const recordsByHash = new Map(records.map((r) => [r.urlHash, r]));
  const currentHashes = new Set(recordsByHash.keys());
  const allHashes = new Set([...currentHashes, ...statusByHash.keys()]);

  const insertPresent = db.prepare(
    `INSERT INTO url_status (site_id, url_hash, original_url, normalized_url, is_present, missing_streak, last_seen_run_id, updated_at)
     VALUES (@site_id, @url_hash, @original_url, @normalized_url, 1, 0, @run_id, @ts)`,
  );
  const touchPresent = db.prepare(
    `UPDATE url_status SET last_seen_run_id = @run_id, updated_at = @ts
     WHERE site_id = @site_id AND url_hash = @url_hash`,
  );
  const restorePresent = db.prepare(
    `UPDATE url_status SET
       is_present = 1, missing_streak = 0,
       original_url = @original_url, normalized_url = @normalized_url,
       last_seen_run_id = @run_id, last_change_run_id = @run_id, updated_at = @ts
     WHERE site_id = @site_id AND url_hash = @url_hash`,
  );
  const markMissing = db.prepare(
    `UPDATE url_status SET
       is_present = 0, missing_streak = @streak,
       last_change_run_id = COALESCE(@change_run_id, last_change_run_id), updated_at = @ts
     WHERE site_id = @site_id AND url_hash = @url_hash`,
  );
  // INSERT OR IGNORE：和 added_urls 的写入方式一致——同一个 (run_id, site_id,
  // url_hash) 理论上不会被处理第二次（collect-runner.js 每站每次运行只调用
  // 一次本函数），但保持幂等写法，防止未来任何重试路径导致唯一约束冲突
  // 把整个事务打断。
  const insertChange = db.prepare(
    `INSERT OR IGNORE INTO url_changes (run_id, site_id, url_hash, original_url, normalized_url, change_type, detected_at)
     VALUES (@run_id, @site_id, @url_hash, @original_url, @normalized_url, @change_type, @ts)`,
  );

  let missingCount = 0;
  let consecutiveMissingCount = 0;
  let restoredCount = 0;

  for (const hash of allHashes) {
    const prior = statusByHash.get(hash);
    if (currentHashes.has(hash)) {
      const rec = recordsByHash.get(hash);
      if (!prior) {
        insertPresent.run({ site_id: siteId, url_hash: hash, original_url: rec.originalUrl, normalized_url: rec.normalizedUrl, run_id: runId, ts });
      } else if (prior.is_present) {
        touchPresent.run({ site_id: siteId, url_hash: hash, run_id: runId, ts });
      } else {
        restorePresent.run({ site_id: siteId, url_hash: hash, original_url: rec.originalUrl, normalized_url: rec.normalizedUrl, run_id: runId, ts });
        insertChange.run({ run_id: runId, site_id: siteId, url_hash: hash, original_url: rec.originalUrl, normalized_url: rec.normalizedUrl, change_type: 'restored', ts });
        restoredCount++;
      }
    } else {
      // prior 一定存在：allHashes 只由 currentHashes 和 statusByHash 的 key 并集组成。
      if (prior.is_present) {
        markMissing.run({ site_id: siteId, url_hash: hash, streak: 1, change_run_id: runId, ts });
        insertChange.run({ run_id: runId, site_id: siteId, url_hash: hash, original_url: prior.original_url, normalized_url: prior.normalized_url, change_type: 'missing', ts });
        missingCount++;
      } else {
        const newStreak = prior.missing_streak + 1;
        const firesConsecutive = newStreak === 2;
        markMissing.run({ site_id: siteId, url_hash: hash, streak: newStreak, change_run_id: firesConsecutive ? runId : null, ts });
        if (firesConsecutive) {
          insertChange.run({ run_id: runId, site_id: siteId, url_hash: hash, original_url: prior.original_url, normalized_url: prior.normalized_url, change_type: 'consecutive_missing', ts });
          consecutiveMissingCount++;
        }
      }
    }
  }

  return { missingCount, consecutiveMissingCount, restoredCount };
}

/**
 * 记录一个被拒绝（partial / failed / 被截断 / 空）的站点结果：只写运行诊断，
 * 绝不更新 seen_urls / added_urls / baseline，保留之前的全部历史。
 */
export function recordRejectedSiteResult(db, { runId, site, result, now }) {
  const ts = now || new Date().toISOString();
  const siteId = site.site_id;
  const errorSummary = summarizeErrors(result);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE sites SET
         last_attempt_at = @ts,
         last_status = @status,
         last_error = @error,
         updated_at = @ts
       WHERE site_id = @site_id`,
    ).run({ site_id: siteId, ts, status: result?.status || 'failed', error: errorSummary });

    insertSiteCrawlRun(db, { runId, site, result, addedCount: 0, ts, errorSummary });
  });

  tx();
  return { status: result?.status || 'failed' };
}

function upsertEndpoints(db, siteId, processedSitemaps, ts) {
  const stmt = db.prepare(
    `INSERT INTO sitemap_endpoints (site_id, url, first_seen_at, last_seen_at, last_status)
     VALUES (@site_id, @url, @ts, @ts, @status)
     ON CONFLICT(site_id, url) DO UPDATE SET
       last_seen_at = @ts,
       last_status = @status`,
  );
  for (const ep of processedSitemaps) {
    if (!ep || !ep.url) continue;
    stmt.run({ site_id: siteId, url: ep.url, ts, status: ep.status || null });
  }
}

function insertSiteCrawlRun(db, { runId, site, result, addedCount, ts, errorSummary, missingCount, consecutiveMissingCount, restoredCount, comparisonPerformed }) {
  db.prepare(
    `INSERT INTO site_crawl_runs
       (run_id, site_id, status, complete, truncated, page_url_count, added_url_count,
        missing_url_count, consecutive_missing_count, restored_url_count, comparison_performed,
        started_at, finished_at, duration_ms, error_summary)
     VALUES (@run_id, @site_id, @status, @complete, @truncated, @page_url_count, @added_url_count,
             @missing_url_count, @consecutive_missing_count, @restored_url_count, @comparison_performed,
             @started_at, @finished_at, @duration_ms, @error_summary)
     ON CONFLICT(run_id, site_id) DO UPDATE SET
       status = @status, complete = @complete, truncated = @truncated,
       page_url_count = @page_url_count, added_url_count = @added_url_count,
       missing_url_count = @missing_url_count, consecutive_missing_count = @consecutive_missing_count,
       restored_url_count = @restored_url_count, comparison_performed = @comparison_performed,
       started_at = @started_at, finished_at = @finished_at, duration_ms = @duration_ms,
       error_summary = @error_summary`,
  ).run({
    run_id: runId,
    site_id: site.site_id,
    status: result?.status || 'failed',
    complete: result?.complete ? 1 : 0,
    truncated: result?.truncated ? 1 : 0,
    page_url_count: Number(result?.pageUrlCount) || 0,
    added_url_count: addedCount || 0,
    missing_url_count: missingCount || 0,
    consecutive_missing_count: consecutiveMissingCount || 0,
    restored_url_count: restoredCount || 0,
    comparison_performed: comparisonPerformed ? 1 : 0,
    started_at: result?.startedAt || null,
    finished_at: result?.finishedAt || ts,
    duration_ms: Number(result?.durationMs) || null,
    error_summary: errorSummary || null,
  });
}

function summarizeErrors(result) {
  const errors = result?.errors || [];
  if (errors.length === 0) {
    return result?.status ? `status=${result.status}` : null;
  }
  return errors
    .slice(0, 5)
    .map((e) => `[${e.code || '?'}] ${e.message || ''}${e.url ? ` (${e.url})` : ''}`)
    .join('; ');
}

function dedupeByHash(records) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    if (seen.has(rec.urlHash)) continue;
    seen.add(rec.urlHash);
    out.push(rec);
  }
  return out;
}

/** 汇总数据库状态，供 --db-status 使用。 */
export function getDbStatus(db) {
  const siteCount = db.prepare('SELECT COUNT(*) AS n FROM sites').get().n;
  const enabledCount = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE enabled = 1').get().n;
  const baselineCount = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE baseline_completed_at IS NOT NULL').get().n;
  const seenUrlCount = db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n;
  const addedUrlCount = db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n;

  const lastRun = db
    .prepare('SELECT * FROM crawl_runs ORDER BY started_at DESC LIMIT 1')
    .get();

  const recentSuccess = db
    .prepare(
      `SELECT site_id, last_success_at FROM sites
       WHERE last_status = 'success' AND last_success_at IS NOT NULL
       ORDER BY last_success_at DESC LIMIT 5`,
    )
    .all();

  const recentFailed = db
    .prepare(
      `SELECT site_id, last_status, last_error, last_attempt_at FROM sites
       WHERE last_status IN ('partial', 'failed')
       ORDER BY last_attempt_at DESC LIMIT 5`,
    )
    .all();

  return {
    siteCount,
    enabledCount,
    baselineCount,
    seenUrlCount,
    addedUrlCount,
    lastRun: lastRun || null,
    recentSuccess,
    recentFailed,
  };
}
