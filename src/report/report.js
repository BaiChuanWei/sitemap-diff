import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toCsv } from './csv.js';

/**
 * 为某次运行生成本地报告到 output/YYYY-MM-DD/<run_id>/：
 *   new-urls.csv / new-urls.json / new-games.csv / unknown-urls.csv / report.md
 *
 * 只读 SQLite（crawl_runs / site_crawl_runs / url_classifications / added_urls /
 * sites），不做任何写库；因此报告生成失败绝不会破坏历史数据。
 * 幂等：同一 run 重复生成 → 同一目录、相同内容；不同 run → 不同 <run_id> 子目录，
 * 不会无提示覆盖别的 run 的报告。
 *
 * @returns { runId, date, dir, files: {...}, stats }
 */
export function generateReport(db, { runId, outputDir, now } = {}) {
  const run = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(runId) || null;
  const date = deriveDate(run, now);

  const rows = db
    .prepare(
      `SELECT
         a.detected_at   AS detected_at,
         c.run_id        AS run_id,
         c.site_id       AS site_id,
         s.domain        AS domain,
         c.sitemap_url   AS sitemap_url,
         c.original_url  AS original_url,
         c.normalized_url AS normalized_url,
         c.page_type     AS page_type,
         c.game_name     AS game_name,
         c.confidence    AS confidence,
         c.evidence      AS evidence,
         c.classification_error AS classification_error
       FROM url_classifications c
       LEFT JOIN added_urls a ON a.run_id = c.run_id AND a.site_id = c.site_id AND a.url_hash = c.url_hash
       LEFT JOIN sites s ON s.site_id = c.site_id
       WHERE c.run_id = ?
       ORDER BY c.site_id, c.original_url`,
    )
    .all(runId);

  const siteRuns = db.prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? ORDER BY site_id').all(runId);

  const games = rows.filter((r) => r.page_type === 'game');
  const nonGames = rows.filter((r) => r.page_type === 'non_game');
  const unknowns = rows.filter((r) => r.page_type === 'unknown');
  const classificationErrors = rows.filter((r) => r.classification_error).length;

  // Dashboard M4：missing / consecutive_missing / restored 不经过分类器，
  // 直接读 url_changes——三种类型共用同一次查询，按 change_type 分桶。
  const changeRows = db
    .prepare(
      `SELECT c.detected_at, c.run_id, c.site_id, s.domain, c.original_url, c.normalized_url, c.change_type
       FROM url_changes c
       LEFT JOIN sites s ON s.site_id = c.site_id
       WHERE c.run_id = ?
       ORDER BY c.site_id, c.original_url`,
    )
    .all(runId);
  const missingRows = changeRows.filter((r) => r.change_type === 'missing');
  const consecutiveMissingRows = changeRows.filter((r) => r.change_type === 'consecutive_missing');
  const restoredRows = changeRows.filter((r) => r.change_type === 'restored');

  const dir = join(outputDir, date, runId);
  mkdirSync(dir, { recursive: true });

  const CSV_HEADERS = [
    'detected_at', 'run_id', 'site_id', 'domain', 'sitemap_url',
    'original_url', 'normalized_url', 'page_type', 'game_name',
    'confidence', 'evidence', 'classification_error',
  ];
  const CHANGE_CSV_HEADERS = ['detected_at', 'run_id', 'site_id', 'domain', 'original_url', 'normalized_url'];

  const files = {
    newUrlsCsv: join(dir, 'new-urls.csv'),
    newUrlsJson: join(dir, 'new-urls.json'),
    newGamesCsv: join(dir, 'new-games.csv'),
    unknownUrlsCsv: join(dir, 'unknown-urls.csv'),
    reportMd: join(dir, 'report.md'),
    missingUrlsCsv: join(dir, 'missing-urls.csv'),
    consecutiveMissingUrlsCsv: join(dir, 'consecutive-missing-urls.csv'),
    restoredUrlsCsv: join(dir, 'restored-urls.csv'),
    changesJson: join(dir, 'changes.json'),
  };

  writeFileSync(files.newUrlsCsv, toCsv(CSV_HEADERS, rows), 'utf-8');
  writeFileSync(files.newGamesCsv, toCsv(CSV_HEADERS, games), 'utf-8');
  writeFileSync(files.unknownUrlsCsv, toCsv(CSV_HEADERS, unknowns), 'utf-8');
  writeFileSync(files.missingUrlsCsv, toCsv(CHANGE_CSV_HEADERS, missingRows), 'utf-8');
  writeFileSync(files.consecutiveMissingUrlsCsv, toCsv(CHANGE_CSV_HEADERS, consecutiveMissingRows), 'utf-8');
  writeFileSync(files.restoredUrlsCsv, toCsv(CHANGE_CSV_HEADERS, restoredRows), 'utf-8');

  const jsonRows = rows.map((r) => ({ ...r, evidence: safeParse(r.evidence) }));
  writeFileSync(files.newUrlsJson, JSON.stringify({ runId, date, count: rows.length, urls: jsonRows }, null, 2), 'utf-8');
  writeFileSync(
    files.changesJson,
    JSON.stringify(
      {
        runId,
        date,
        // 明确说明：missing / consecutiveMissing 不代表页面被永久删除，只表示
        // 本次可靠采集结果里暂时没有发现该 URL，见 report.md 的对应提示。
        added: jsonRows,
        missing: missingRows,
        consecutiveMissing: consecutiveMissingRows,
        restored: restoredRows,
      },
      null,
      2,
    ),
    'utf-8',
  );

  const stats = {
    runId,
    date,
    startedAt: run?.started_at ?? null,
    finishedAt: run?.finished_at ?? null,
    runStatus: run?.status ?? null,
    sitesTotal: run?.sites_total ?? siteRuns.length,
    sitesSuccess: run?.sites_success ?? 0,
    sitesPartial: run?.sites_partial ?? 0,
    sitesFailed: run?.sites_failed ?? 0,
    addedTotal: rows.length,
    gameCount: games.length,
    nonGameCount: nonGames.length,
    unknownCount: unknowns.length,
    classificationErrors,
    missingTotal: missingRows.length,
    consecutiveMissingTotal: consecutiveMissingRows.length,
    restoredTotal: restoredRows.length,
  };

  writeFileSync(files.reportMd, buildMarkdown(stats, siteRuns, files, dir), 'utf-8');

  return { runId, date, dir, files, stats };
}

function buildMarkdown(stats, siteRuns, files, dir) {
  const perSite = siteRuns
    .map((s) => {
      const compareCell = s.comparison_performed
        ? `${s.missing_url_count} / ${s.consecutive_missing_count} / ${s.restored_url_count}`
        : '未进行变化对比';
      return `| ${s.site_id} | ${s.status} | ${s.page_url_count} | ${s.added_url_count} | ${compareCell} | ${s.error_summary || ''} |`;
    })
    .join('\n');
  const failedSites = siteRuns.filter((s) => s.status !== 'success').map((s) => s.site_id);

  return `# 采集与初筛报告

- **run_id**：\`${stats.runId}\`
- **运行时间**：${stats.startedAt || '?'} → ${stats.finishedAt || '(未记录)'}
- **整体状态**：${stats.runStatus || '?'}

## 站点

- 总站点数：${stats.sitesTotal}
- 成功 / partial / 失败：${stats.sitesSuccess} / ${stats.sitesPartial} / ${stats.sitesFailed}
- 失败站点：${failedSites.length ? failedSites.join(', ') : '无'}

## 新增 URL 初筛

- 新增 URL 总数：${stats.addedTotal}
- game：${stats.gameCount}
- non_game：${stats.nonGameCount}
- unknown：${stats.unknownCount}
- 分类失败（页面抓取失败等）：${stats.classificationErrors}

## URL 变化（与上一次可靠 Sitemap 结果相比）

- 新增：${stats.addedTotal}
- 本轮缺失：${stats.missingTotal}
- 连续两轮缺失：${stats.consecutiveMissingTotal}
- 恢复：${stats.restoredTotal}

> **"本轮缺失"和"连续两轮缺失"不代表页面被永久删除**，只表示在本次可靠的
> Sitemap 采集结果里暂时没有再发现这个 URL，可能是网站临时调整、抓取顺序
> 变化等原因——本工具不会自动请求这些 URL 去验证是否 404，也不会把它们
> 从历史记录里删除。partial / failed / 被截断的运行不参与变化对比（见下表
> "未进行变化对比"），不会影响这个统计。

## 各站变化数量

| site_id | 状态 | 页面 URL 数 | 新增 URL 数 | 缺失 / 连续两轮缺失 / 恢复 | 错误摘要 |
|---|---|---|---|---|---|
${perSite || '| （无站点级记录） | | | | | |'}

## 输出文件

- \`${files.newUrlsCsv}\`
- \`${files.newUrlsJson}\`
- \`${files.newGamesCsv}\`
- \`${files.unknownUrlsCsv}\`
- \`${files.missingUrlsCsv}\`
- \`${files.consecutiveMissingUrlsCsv}\`
- \`${files.restoredUrlsCsv}\`
- \`${files.changesJson}\`
- \`${files.reportMd}\`

> 目录：\`${dir}\`
`;
}

function deriveDate(run, now) {
  const iso = run?.started_at || (now ? now() : new Date().toISOString());
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return new Date().toISOString().slice(0, 10);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}
