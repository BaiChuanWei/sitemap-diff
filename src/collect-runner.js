import { randomUUID } from 'node:crypto';
import { collectSite } from './sitemap/collector.js';
import {
  createCrawlRun,
  finishCrawlRun,
  persistCompleteSiteResult,
  recordRejectedSiteResult,
  isAdmissible,
} from './storage/index.js';
import { resolveSiteLimits, resolveSiteSitemaps } from './site-overrides.js';

/**
 * 采集运行编排：遍历站点，逐站调用 Milestone 2 采集器，按准入规则决定
 * 是否写入正式 URL 历史，最后汇总成整体运行记录。
 *
 * 关键保证：
 *   - 网络采集在数据库事务之外完成，确认完整后才开短事务写库；
 *   - 单站失败（采集抛错、或写库抛错）不会终止其他站点；
 *   - 只有 isAdmissible 的完整成功结果才更新 seen_urls / added_urls / baseline，
 *     partial / failed / 截断 / 空结果只记录运行诊断。
 *
 * @param sites               站点行数组（至少含 site_id、domain，可选 sitemap_url）
 * @param collectSiteFn       可注入的采集函数（默认 Milestone 2 的 collectSite），便于测试
 * @param limits              全局默认 limits（不传则用 DEFAULT_LIMITS）
 * @param siteLimitOverrides  Milestone 5A-P1：站点级限制覆盖 Map（resolveSiteLimits 用）
 * @param siteSitemapOverrides Milestone 5A-P1：手工 Sitemap 配置 Map（resolveSiteSitemaps 用）
 * @param onEvent(type, payload)  Dashboard M3：可选的结构化事件回调，在每站开始/发现
 *                            Sitemap/每站结束时调用；不传时行为和事件都不存在，
 *                            完全等价于 M3 之前的版本。回调本身抛错只记录，绝不
 *                            影响正式采集（浏览器断开、前端 bug 都不能打断采集）。
 * @param shouldCancel()      Dashboard M3：可选的协作式取消检查，在**开始下一个
 *                            站点之前**调用；返回 true 时不再调度新站点，但已经
 *                            在 await 的当前站点会正常跑完并正常写入历史——这是
 *                            "安全停止"而不是强制中断。不传时永远不取消，行为
 *                            与 M3 之前完全一致。
 */
export async function runCollect(
  db,
  {
    sites,
    runId = randomUUID(),
    collectSiteFn = collectSite,
    limits,
    siteLimitOverrides,
    siteSitemapOverrides,
    now,
    onEvent,
    shouldCancel,
  } = {},
) {
  const emit = (type, payload) => {
    if (!onEvent) return;
    try {
      onEvent(type, payload);
    } catch {
      // 事件回调抛错不能影响正式采集，吞掉即可（调用方如果需要记录，
      // 应该在自己的 onEvent 实现内部 try/catch 并记日志）。
    }
  };

  const startedAt = (now && now()) || new Date().toISOString();
  createCrawlRun(db, { runId, startedAt });

  const stats = {
    sitesTotal: sites.length,
    sitesSuccess: 0,
    sitesPartial: 0,
    sitesFailed: 0,
    baselineSiteCount: 0,
    baselineUrlCount: 0,
    addedUrlCount: 0,
  };
  const siteOutcomes = [];
  const errorSummaries = [];
  let cancelled = false;

  for (let index = 0; index < sites.length; index++) {
    if (shouldCancel && shouldCancel()) {
      cancelled = true;
      break;
    }

    const site = sites[index];
    const ts = (now && now()) || new Date().toISOString();
    const siteStartedAtMs = Date.now();
    emit('site_started', {
      runId,
      siteId: site.site_id,
      domain: site.domain || null,
      index: index + 1,
      total: sites.length,
      startedAt: ts,
    });

    let result;
    try {
      const resolvedLimits = siteLimitOverrides ? resolveSiteLimits(site.site_id, siteLimitOverrides, limits) : limits;
      const params = buildCollectParams(site, resolvedLimits);
      if (siteSitemapOverrides) {
        const { mode, urls } = resolveSiteSitemaps(site.site_id, siteSitemapOverrides);
        if (urls.length) params.manualSitemaps = urls;
        if (mode) params.discoveryMode = mode;
      }
      result = await collectSiteFn(params);
    } catch (err) {
      // 采集阶段抛错也不能终止整轮：构造一个 failed 结果继续
      result = failedResult(site, err);
    }

    emit('sitemap_discovered', {
      runId,
      siteId: site.site_id,
      domain: site.domain || null,
      endpointCount: Number(result.sitemapCount) || (result.processedSitemaps ? result.processedSitemaps.length : 0),
    });

    const durationMs = Date.now() - siteStartedAtMs;
    try {
      if (isAdmissible(result)) {
        const persisted = persistCompleteSiteResult(db, { runId, site, result, now: ts });
        stats.sitesSuccess++;
        stats.addedUrlCount += persisted.addedCount;
        if (persisted.isBaseline) {
          stats.baselineSiteCount++;
          stats.baselineUrlCount += persisted.pageUrlCount;
        }
        siteOutcomes.push({ siteId: site.site_id, status: 'success', isBaseline: persisted.isBaseline, added: persisted.addedCount });
        emit('site_finished', {
          runId,
          siteId: site.site_id,
          domain: site.domain || null,
          status: 'success',
          complete: true,
          truncated: false,
          pageUrlCount: persisted.pageUrlCount,
          addedUrlCount: persisted.addedCount,
          isBaseline: persisted.isBaseline,
          durationMs,
          errorCode: null,
          errorSummary: null,
        });
      } else {
        recordRejectedSiteResult(db, { runId, site, result, now: ts });
        // 聚合分桶必须以"是否真的彻底失败"（result.status === 'failed'）为准，
        // 不能只识别 'partial' 而把其余全部计入 failed——否则 status=success
        // 但因 pageUrlCount=0 等原因未被准入的结果（如 html5games.com 这类
        // 空内容站点）会被错误计入 sites_failed，而 site_crawl_runs 里持久化
        // 的仍是 status=success，导致汇总统计与逐站表相互矛盾。
        if (result.status === 'failed') stats.sitesFailed++;
        else stats.sitesPartial++;
        siteOutcomes.push({ siteId: site.site_id, status: result.status });
        const firstError = result.errors && result.errors[0];
        if (firstError) {
          errorSummaries.push(`${site.site_id}: ${firstError.code || 'ERROR'}`);
        }
        emit('site_finished', {
          runId,
          siteId: site.site_id,
          domain: site.domain || null,
          status: result.status,
          complete: !!result.complete,
          truncated: !!result.truncated,
          pageUrlCount: Number(result.pageUrlCount) || 0,
          addedUrlCount: 0,
          isBaseline: false,
          durationMs,
          errorCode: firstError ? firstError.code || null : null,
          errorSummary: firstError ? firstError.message || null : null,
        });
      }
    } catch (dbErr) {
      // 写库阶段抛错：该站记为失败，但绝不影响其他站点。
      stats.sitesFailed++;
      errorSummaries.push(`${site.site_id}: DB_WRITE_FAILED ${dbErr.message}`);
      try {
        recordRejectedSiteResult(db, {
          runId,
          site,
          result: { ...(result || {}), status: 'failed', complete: false, errors: [{ code: 'DB_WRITE_FAILED', message: dbErr.message }] },
          now: ts,
        });
      } catch {
        // 连诊断记录都写不进去也不再抛，保证循环继续
      }
      siteOutcomes.push({ siteId: site.site_id, status: 'failed' });
      emit('site_finished', {
        runId,
        siteId: site.site_id,
        domain: site.domain || null,
        status: 'failed',
        complete: false,
        truncated: false,
        pageUrlCount: 0,
        addedUrlCount: 0,
        isBaseline: false,
        durationMs,
        errorCode: 'DB_WRITE_FAILED',
        errorSummary: dbErr.message,
      });
    }
  }

  const finishedAt = (now && now()) || new Date().toISOString();
  const overallStatus = cancelled
    ? 'cancelled'
    : stats.sitesFailed === 0 && stats.sitesPartial === 0
      ? 'success'
      : stats.sitesSuccess > 0
        ? 'partial'
        : 'failed';
  finishCrawlRun(db, {
    runId,
    finishedAt,
    status: overallStatus,
    stats,
    errorSummary: errorSummaries.slice(0, 20).join('; ') || null,
  });

  return { runId, status: overallStatus, stats, siteOutcomes, cancelled };
}

/** 从站点行构造 Milestone 2 采集器的调用参数（domain → baseUrl，sitemap_url → 手工入口）。 */
export function buildCollectParams(site, limits) {
  const params = { siteId: site.site_id, domain: site.domain || null, limits };
  if (site.domain) params.baseUrl = `https://${site.domain}`;
  if (site.sitemap_url) params.manualSitemapUrl = site.sitemap_url;
  return params;
}

function failedResult(site, err) {
  const nowIso = new Date().toISOString();
  return {
    siteId: site.site_id,
    domain: site.domain || null,
    status: 'failed',
    complete: false,
    truncated: false,
    truncationReasons: [],
    startedAt: nowIso,
    finishedAt: nowIso,
    durationMs: 0,
    discoveredSitemaps: [],
    processedSitemaps: [],
    failedSitemaps: [],
    pageUrls: [],
    pageUrlCount: 0,
    sitemapCount: 0,
    warnings: [],
    errors: [{ url: site.domain ? `https://${site.domain}` : null, code: 'COLLECT_THREW', message: err.message }],
  };
}
