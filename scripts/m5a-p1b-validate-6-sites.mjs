#!/usr/bin/env node
/**
 * Milestone 5A-P1-B：6 站配置与隔离验证。
 *
 * 只验证 itch/kongregate/playgama/playhop/lagged/pbskids 这 6 个站，使用全新
 * 的隔离数据库 data/m5a-p1b-6-sites.db（不是 data/local.db，也不是
 * data/m5-validation-101-sites.db），套用 config/site-limits.csv +
 * config/site-sitemaps.csv 里为这 6 站建立的正式覆盖配置。
 *
 * 用法：node scripts/m5a-p1b-validate-6-sites.mjs
 */
import { statSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/index.js';
import { loadLocalConfig, parseSitesCsv, loadSiteOverrides } from '../src/config.js';
import { runCollect } from '../src/collect-runner.js';
import { collectSite } from '../src/sitemap/collector.js';
import { classifyRun } from '../src/classify/runner.js';
import { generateReport } from '../src/report/report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const TARGET_SITE_IDS = ['itch', 'kongregate', 'playgama', 'playhop', 'lagged', 'pbskids'];

const config = loadLocalConfig({ dbPath: join(projectRoot, 'data', 'm5a-p1b-6-sites.db') });
const allRecords = parseSitesCsv(readFileSync(config.sitesCsvPath, 'utf-8'));
const knownSiteIds = new Set(allRecords.map((r) => r.site_id));
const { limitOverrides, sitemapOverrides } = loadSiteOverrides(config, { knownSiteIds });

const SITES = TARGET_SITE_IDS.map((id) => {
  const rec = allRecords.find((r) => r.site_id === id);
  if (!rec) throw new Error(`config/sites.csv 里找不到 site_id=${id}`);
  return { site_id: rec.site_id, domain: rec.domain, sitemap_url: rec.sitemap_url || undefined };
});

function makeInstrumentedCollectSiteFn(perSiteStats) {
  return async (params) => {
    const stats = { totalRequests: 0, count429: 0, count403: 0, count5xx: 0, timeouts: 0, maxDownloadedBytes: 0 };
    const instrumentedFetch = async (url, opts) => {
      stats.totalRequests++;
      try {
        const res = await fetch(url, opts);
        if (res.status === 429) stats.count429++;
        else if (res.status === 403) stats.count403++;
        else if (res.status >= 500 && res.status < 600) stats.count5xx++;
        return res;
      } catch (err) {
        if (err.name === 'AbortError') stats.timeouts++;
        throw err;
      }
    };
    const rssBefore = process.memoryUsage().rss;
    const result = await collectSite({ ...params, fetchImpl: instrumentedFetch });
    const rssAfter = process.memoryUsage().rss;
    stats.sitemapCount = result.sitemapCount;
    const allEndpoints = [...result.processedSitemaps, ...result.failedSitemaps];
    stats.retryCount = allEndpoints.reduce((sum, ep) => sum + Math.max(0, (ep.attempts ?? 1) - 1), 0);
    stats.maxDownloadedBytes = allEndpoints.reduce((max, ep) => Math.max(max, ep.downloadedBytes || 0), 0);
    stats.failedEndpoints = result.failedSitemaps.map((e) => ({ url: e.url, httpStatus: e.httpStatus, errorCode: e.errorCode, errorMessage: e.errorMessage }));
    stats.truncationReasons = result.truncationReasons;
    stats.finalError = result.errors && result.errors.length ? result.errors[0] : null;
    stats.rssDeltaMB = Math.round((rssAfter - rssBefore) / 1024 / 1024);
    stats.rssAfterMB = Math.round(rssAfter / 1024 / 1024);
    perSiteStats.set(params.siteId, stats);
    return result;
  };
}

function dirSizeBytes(dir) {
  return 0; // report dir size not critical for this stage; keep script lean
}

async function runRound(db, label) {
  const perSiteStats = new Map();
  const t0 = Date.now();
  const collectResult = await runCollect(db, {
    sites: SITES,
    collectSiteFn: makeInstrumentedCollectSiteFn(perSiteStats),
    siteLimitOverrides: limitOverrides,
    siteSitemapOverrides: sitemapOverrides,
  });
  const collectDurationMs = Date.now() - t0;

  await classifyRun(db, { runId: collectResult.runId });
  const report = generateReport(db, { runId: collectResult.runId, outputDir: config.outputDir });

  const baselineSiteIds = new Set(
    db.prepare(`SELECT site_id FROM sites WHERE baseline_completed_at IS NOT NULL`).all().map((r) => r.site_id),
  );

  const perSite = SITES.map((s) => {
    const scr = db.prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? AND site_id = ?').get(collectResult.runId, s.site_id);
    const outcome = collectResult.siteOutcomes.find((o) => o.siteId === s.site_id);
    const net = perSiteStats.get(s.site_id) || {};
    const effectiveLimits = limitOverrides.has(s.site_id)
      ? { ...Object.fromEntries(Object.entries(limitOverrides.get(s.site_id))) }
      : {};
    return {
      site_id: s.site_id,
      effectiveLimitOverride: effectiveLimits,
      status: scr?.status ?? null,
      complete: !!scr?.complete,
      truncated: !!scr?.truncated,
      truncationReasons: net.truncationReasons ?? [],
      sitemapEndpointCount: net.sitemapCount ?? null,
      pageUrlCount: scr?.page_url_count ?? 0,
      maxDownloadedBytes: net.maxDownloadedBytes ?? 0,
      isBaseline: outcome?.isBaseline ?? false,
      isBaselineEstablished: baselineSiteIds.has(s.site_id),
      addedUrlCount: scr?.added_url_count ?? 0,
      durationMs: scr?.duration_ms ?? null,
      network: {
        totalRequests: net.totalRequests ?? 0,
        retryCount: net.retryCount ?? 0,
        timeouts: net.timeouts ?? 0,
        count429: net.count429 ?? 0,
        count403: net.count403 ?? 0,
        count5xx: net.count5xx ?? 0,
      },
      rssAfterMB: net.rssAfterMB ?? null,
      rssDeltaMB: net.rssDeltaMB ?? null,
      finalError: net.finalError ?? null,
    };
  });

  return {
    label,
    runId: collectResult.runId,
    aggregate: {
      total: collectResult.stats.sitesTotal,
      success: collectResult.stats.sitesSuccess,
      partial: collectResult.stats.sitesPartial,
      failed: collectResult.stats.sitesFailed,
      baselineSiteCount: collectResult.stats.baselineSiteCount,
      addedUrlCount: collectResult.stats.addedUrlCount,
      collectDurationMs,
      dbSizeBytes: statSync(config.dbPath).size,
    },
    perSite,
    reportDir: report.dir,
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

  console.log('\n=== ROUND 2 ===');
  const round2 = await runRound(db, 'round2');
  console.log(JSON.stringify(round2, null, 2));

  const seenTotal = db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n;
  const addedTotal = db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n;
  console.log(`\n=== 数据库最终状态 === seen_urls=${seenTotal} added_urls=${addedTotal} dbPath=${config.dbPath}`);

  db.close();
}

main();
