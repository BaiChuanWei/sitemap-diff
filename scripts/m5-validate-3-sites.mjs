#!/usr/bin/env node
/**
 * Milestone 5 阶段 2：3 站两轮验证（friv.com 普通 urlset / poki.com Sitemap Index /
 * y8.com XML.GZ，都是已有结构证据的代表站，不用 amzgame.com 这种已知发现失败的站）。
 *
 * 使用独立的验证数据库（data/m5-validation-3-sites.db），不触碰生产用的
 * data/local.db。网络层用 fetchImpl 注入统计 timeout/429/5xx/请求次数，
 * 不修改 fetcher.js/recursive-loader.js 任何一行——只是复用 Milestone 2
 * 已经存在的依赖注入点。
 *
 * 用法：node scripts/m5-validate-3-sites.mjs
 */
import { readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/index.js';
import { loadLocalConfig } from '../src/config.js';
import { runCollect } from '../src/collect-runner.js';
import { collectSite } from '../src/sitemap/collector.js';
import { classifyRun } from '../src/classify/runner.js';
import { generateReport } from '../src/report/report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const SITES = [
  { site_id: 'friv', domain: 'friv.com' },
  { site_id: 'poki', domain: 'poki.com' },
  { site_id: 'y8', domain: 'y8.com' },
];

const config = loadLocalConfig({ dbPath: join(projectRoot, 'data', 'm5-validation-3-sites.db') });

function makeInstrumentedCollectSiteFn(perSiteStats) {
  return async (params) => {
    const stats = { totalRequests: 0, count429: 0, count5xx: 0, timeouts: 0 };
    const instrumentedFetch = async (url, opts) => {
      stats.totalRequests++;
      try {
        const res = await fetch(url, opts);
        if (res.status === 429) stats.count429++;
        else if (res.status >= 500 && res.status < 600) stats.count5xx++;
        return res;
      } catch (err) {
        if (err.name === 'AbortError') stats.timeouts++;
        throw err;
      }
    };
    const result = await collectSite({ ...params, fetchImpl: instrumentedFetch });
    stats.sitemapCount = result.sitemapCount;
    perSiteStats.set(params.siteId, stats);
    return result;
  };
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const f of readdirSync(dir)) total += statSync(join(dir, f)).size;
  return total;
}

async function runRound(db, label) {
  const perSiteStats = new Map();
  const t0 = Date.now();
  const collectResult = await runCollect(db, {
    sites: SITES,
    collectSiteFn: makeInstrumentedCollectSiteFn(perSiteStats),
  });
  const collectDurationMs = Date.now() - t0;

  const classifyResult = await classifyRun(db, { runId: collectResult.runId });
  const report = generateReport(db, { runId: collectResult.runId, outputDir: config.outputDir });

  const perSite = SITES.map((s) => {
    const scr = db
      .prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? AND site_id = ?')
      .get(collectResult.runId, s.site_id);
    const clsRows = db
      .prepare('SELECT page_type, COUNT(*) AS n FROM url_classifications WHERE run_id = ? AND site_id = ? GROUP BY page_type')
      .all(collectResult.runId, s.site_id);
    const classification = Object.fromEntries(clsRows.map((r) => [r.page_type, r.n]));
    const outcome = collectResult.siteOutcomes.find((o) => o.siteId === s.site_id);
    const net = perSiteStats.get(s.site_id) || {};
    return {
      site_id: s.site_id,
      status: scr?.status ?? null,
      complete: !!scr?.complete,
      truncated: !!scr?.truncated,
      sitemapEndpointCount: net.sitemapCount ?? null,
      pageUrlCount: scr?.page_url_count ?? 0,
      isBaseline: outcome?.isBaseline ?? false,
      addedUrlCount: scr?.added_url_count ?? 0,
      durationMs: scr?.duration_ms ?? null,
      network: { totalRequests: net.totalRequests ?? 0, timeouts: net.timeouts ?? 0, count429: net.count429 ?? 0, count5xx: net.count5xx ?? 0 },
      classification: { game: classification.game ?? 0, non_game: classification.non_game ?? 0, unknown: classification.unknown ?? 0 },
    };
  });

  return {
    label,
    runId: collectResult.runId,
    overallStats: collectResult.stats,
    classifyTotals: classifyResult.counts,
    collectDurationMs,
    perSite,
    reportDir: report.dir,
    reportDirSizeBytes: dirSizeBytes(report.dir),
    dbSizeBytes: statSync(config.dbPath).size,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

async function main() {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDb(config.dbPath);
  for (const s of SITES) {
    db.prepare(
      `INSERT INTO sites (site_id, domain, enabled) VALUES (?, ?, 1)
       ON CONFLICT(site_id) DO UPDATE SET domain = excluded.domain`,
    ).run(s.site_id, s.domain);
  }

  console.log('=== ROUND 1: baseline ===');
  const round1 = await runRound(db, 'round1-baseline');
  console.log(JSON.stringify(round1, null, 2));

  console.log('\n=== ROUND 2: 无变化重跑，验证无虚假新增 ===');
  const round2 = await runRound(db, 'round2-no-false-new');
  console.log(JSON.stringify(round2, null, 2));

  const seenTotal = db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n;
  const addedTotal = db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n;
  console.log(`\n=== 数据库最终状态 === seen_urls=${seenTotal} added_urls=${addedTotal} dbPath=${config.dbPath}`);

  db.close();
}

main();
