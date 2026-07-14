#!/usr/bin/env node
/**
 * Milestone 5 阶段3：10 站两轮验证（总共 10 个站，不是在已验证的 3 个站之外
 * 再加 10 个）。复用阶段2 已经建立 baseline 的 friv/poki/y8（验证数据库从
 * data/m5-validation-3-sites.db 拷贝而来，历史状态保留），新增 7 个站首次
 * 在本库出现，应该各自独立建立 baseline。
 *
 * newgrounds.com 是已知可能 403 的失败隔离观察对象，特意混进来验证单站失败
 * 不影响其他站。
 *
 * 用法：node scripts/m5-validate-10-sites.mjs
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
  { site_id: 'crazygames', domain: 'crazygames.com' },
  { site_id: 'coolmathgames', domain: 'coolmathgames.com' },
  { site_id: 'itch', domain: 'itch.io' },
  { site_id: 'gogy', domain: 'gogy.com' },
  { site_id: 'storytellergame', domain: 'storytellergame.io' },
  { site_id: 'brainrot_games', domain: 'brainrot-games.io' },
  { site_id: 'newgrounds', domain: 'newgrounds.com' },
];

const config = loadLocalConfig({ dbPath: join(projectRoot, 'data', 'm5-validation-10-sites.db') });

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
    const allEndpoints = [...result.processedSitemaps, ...result.failedSitemaps];
    stats.retryCount = allEndpoints.reduce((sum, ep) => sum + Math.max(0, (ep.attempts ?? 1) - 1), 0);
    stats.failedEndpoints = result.failedSitemaps.map((e) => ({
      url: e.url,
      httpStatus: e.httpStatus,
      errorCode: e.errorCode,
      errorMessage: e.errorMessage,
    }));
    stats.truncationReasons = result.truncationReasons;
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
      truncationReasons: net.truncationReasons ?? [],
      sitemapEndpointCount: net.sitemapCount ?? null,
      pageUrlCount: scr?.page_url_count ?? 0,
      isBaseline: outcome?.isBaseline ?? false,
      addedUrlCount: scr?.added_url_count ?? 0,
      durationMs: scr?.duration_ms ?? null,
      network: {
        totalRequests: net.totalRequests ?? 0,
        retryCount: net.retryCount ?? 0,
        timeouts: net.timeouts ?? 0,
        count429: net.count429 ?? 0,
        count5xx: net.count5xx ?? 0,
      },
      failedEndpoints: net.failedEndpoints ?? [],
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

  console.log('=== ROUND 1 ===');
  const round1 = await runRound(db, 'round1');
  console.log(JSON.stringify(round1, null, 2));

  console.log('\n=== ROUND 2: 短时间内重跑，验证无虚假新增 + 单站失败隔离 ===');
  const round2 = await runRound(db, 'round2');
  console.log(JSON.stringify(round2, null, 2));

  const seenTotal = db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n;
  const addedTotal = db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n;
  const clsTotal = db.prepare('SELECT COUNT(*) AS n FROM url_classifications').get().n;
  console.log(
    `\n=== 数据库最终状态 === seen_urls=${seenTotal} added_urls=${addedTotal} url_classifications=${clsTotal} dbPath=${config.dbPath}`,
  );

  db.close();
}

main();
