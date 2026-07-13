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

  const dir = join(outputDir, date, runId);
  mkdirSync(dir, { recursive: true });

  const CSV_HEADERS = [
    'detected_at', 'run_id', 'site_id', 'domain', 'sitemap_url',
    'original_url', 'normalized_url', 'page_type', 'game_name',
    'confidence', 'evidence', 'classification_error',
  ];

  const files = {
    newUrlsCsv: join(dir, 'new-urls.csv'),
    newUrlsJson: join(dir, 'new-urls.json'),
    newGamesCsv: join(dir, 'new-games.csv'),
    unknownUrlsCsv: join(dir, 'unknown-urls.csv'),
    reportMd: join(dir, 'report.md'),
  };

  writeFileSync(files.newUrlsCsv, toCsv(CSV_HEADERS, rows), 'utf-8');
  writeFileSync(files.newGamesCsv, toCsv(CSV_HEADERS, games), 'utf-8');
  writeFileSync(files.unknownUrlsCsv, toCsv(CSV_HEADERS, unknowns), 'utf-8');

  const jsonRows = rows.map((r) => ({ ...r, evidence: safeParse(r.evidence) }));
  writeFileSync(files.newUrlsJson, JSON.stringify({ runId, date, count: rows.length, urls: jsonRows }, null, 2), 'utf-8');

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
  };

  writeFileSync(files.reportMd, buildMarkdown(stats, siteRuns, files, dir), 'utf-8');

  return { runId, date, dir, files, stats };
}

function buildMarkdown(stats, siteRuns, files, dir) {
  const perSite = siteRuns
    .map((s) => `| ${s.site_id} | ${s.status} | ${s.page_url_count} | ${s.added_url_count} | ${s.error_summary || ''} |`)
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

## 各站新增数量

| site_id | 状态 | 页面 URL 数 | 新增 URL 数 | 错误摘要 |
|---|---|---|---|---|
${perSite || '| （无站点级记录） | | | | |'}

## 输出文件

- \`${files.newUrlsCsv}\`
- \`${files.newUrlsJson}\`
- \`${files.newGamesCsv}\`
- \`${files.unknownUrlsCsv}\`
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
