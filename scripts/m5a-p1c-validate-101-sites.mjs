#!/usr/bin/env node
/**
 * Milestone 5A-P1-C：101 站全量回归验证。
 *
 * 从 data/m5-validation-101-sites.db（68 个有效站 baseline 的最终干净版本）
 * 复制出 data/m5a-p1c-101-sites.db，套用正式启用的 config/site-limits.csv +
 * config/site-sitemaps.csv（kongregate/playgama/playhop/lagged/pbskids 的
 * 站点级覆盖 + 手工 Sitemap；itch 不设覆盖，继续默认限制)，验证 5 个新恢复
 * 站在全量 101 站并发环境下是否依然稳定，并确认原 68 个有效站没有回归。
 *
 * 互斥统计口径：effectiveSuccess + zeroValueSuccess + partial + failed = 101，
 * 与 rawTechnicalSuccess / currentRoundAdmittedSuccess 分开记录，不混用。
 *
 * 用法：node scripts/m5a-p1c-validate-101-sites.mjs
 */
import { readdirSync, statSync, mkdirSync } from 'node:fs';
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

const config = loadLocalConfig({ dbPath: join(projectRoot, 'data', 'm5a-p1c-101-sites.db') });
const allRecords = parseSitesCsv(readFileSync(config.sitesCsvPath, 'utf-8'));
const knownSiteIds = new Set(allRecords.map((r) => r.site_id));
const { limitOverrides, sitemapOverrides } = loadSiteOverrides(config, { knownSiteIds });

// 全部 101 站：就是 config/sites.csv 的全部行（enabled 与否都纳入，与此前
// 101 站阶段保持完全一致的站点集合，不做任何新增/裁剪）。
const SITES = allRecords.map((r) => ({ site_id: r.site_id, domain: r.domain, sitemap_url: r.sitemap_url || undefined }));

const KNOWN_FAKE_CONTENT_DESPITE_NONZERO_COUNT = new Set([]);

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
    const result = await collectSite({ ...params, fetchImpl: instrumentedFetch });
    stats.sitemapCount = result.sitemapCount;
    const allEndpoints = [...result.processedSitemaps, ...result.failedSitemaps];
    stats.retryCount = allEndpoints.reduce((sum, ep) => sum + Math.max(0, (ep.attempts ?? 1) - 1), 0);
    stats.maxDownloadedBytes = allEndpoints.reduce((max, ep) => Math.max(max, ep.downloadedBytes || 0), 0);
    stats.failedEndpoints = result.failedSitemaps.map((e) => ({ url: e.url, httpStatus: e.httpStatus, errorCode: e.errorCode, errorMessage: e.errorMessage }));
    stats.truncationReasons = result.truncationReasons;
    stats.finalError = result.errors && result.errors.length ? result.errors[0] : null;
    perSiteStats.set(params.siteId, stats);
    return result;
  };
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const f of readdirSync(dir)) total += statSync(join(dir, f)).size;
  return total;
}

/** 与阶段6一致的有效稳定站判定：不做统一最小 URL 数门槛，只排除零价值/伪造内容。 */
function evaluateEffectiveStable({ scr, siteId, isBaselineEstablished }) {
  if (!scr) return { effective: false, reason: '本轮无 site_crawl_runs 记录' };
  if (scr.status !== 'success') return { effective: false, reason: `status=${scr.status}，非技术成功` };
  if (!scr.complete) return { effective: false, reason: 'complete=false，结果不完整' };
  if (scr.truncated) return { effective: false, reason: 'truncated=true，数据被截断' };
  if (!isBaselineEstablished) return { effective: false, reason: '尚未建立 baseline' };
  if (Number(scr.page_url_count) === 0) return { effective: false, reason: 'pageUrlCount=0，技术成功但无真实可监控 URL（零价值成功）' };
  if (KNOWN_FAKE_CONTENT_DESPITE_NONZERO_COUNT.has(siteId)) return { effective: false, reason: 'pageUrlCount>0 但内容已实测确认为占位/错误页' };
  return { effective: true, reason: null };
}

async function runRound(db, label) {
  const perSiteStats = new Map();
  let peakRssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const rssSampler = setInterval(() => {
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rssMB > peakRssMB) peakRssMB = rssMB;
  }, 500);

  const dbSizeBefore = statSync(config.dbPath).size;
  const t0 = Date.now();
  const collectResult = await runCollect(db, {
    sites: SITES,
    collectSiteFn: makeInstrumentedCollectSiteFn(perSiteStats),
    siteLimitOverrides: limitOverrides,
    siteSitemapOverrides: sitemapOverrides,
  });
  const collectDurationMs = Date.now() - t0;
  clearInterval(rssSampler);
  const dbSizeAfterCollect = statSync(config.dbPath).size;

  const classifyResult = await classifyRun(db, { runId: collectResult.runId });
  const report = generateReport(db, { runId: collectResult.runId, outputDir: config.outputDir });

  const gameConfidenceRows = db
    .prepare(`SELECT confidence, COUNT(*) AS n FROM url_classifications WHERE run_id = ? AND page_type = 'game' GROUP BY confidence`)
    .all(collectResult.runId);
  const gameConfidence = { high: 0, medium: 0, low: 0 };
  for (const r of gameConfidenceRows) gameConfidence[r.confidence] = r.n;

  const baselineSiteIds = new Set(
    db.prepare(`SELECT site_id FROM sites WHERE baseline_completed_at IS NOT NULL`).all().map((r) => r.site_id),
  );
  const cumulativeBaselineCompleted = baselineSiteIds.size;

  const perSite = SITES.map((s) => {
    const scr = db.prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? AND site_id = ?').get(collectResult.runId, s.site_id);
    const outcome = collectResult.siteOutcomes.find((o) => o.siteId === s.site_id);
    const net = perSiteStats.get(s.site_id) || {};
    const isBaselineEstablished = baselineSiteIds.has(s.site_id);
    const { effective, reason } = evaluateEffectiveStable({ scr, siteId: s.site_id, isBaselineEstablished });
    const isZeroValueSuccess = scr?.status === 'success' && !!scr?.complete && !scr?.truncated && Number(scr?.page_url_count) === 0;
    const override = limitOverrides.get(s.site_id);
    return {
      site_id: s.site_id,
      effectiveLimitOverride: override ? Object.fromEntries(Object.entries(override)) : {},
      status: scr?.status ?? null,
      complete: !!scr?.complete,
      truncated: !!scr?.truncated,
      truncationReasons: net.truncationReasons ?? [],
      sitemapEndpointCount: net.sitemapCount ?? null,
      pageUrlCount: scr?.page_url_count ?? 0,
      maxDownloadedBytes: net.maxDownloadedBytes ?? 0,
      isBaseline: outcome?.isBaseline ?? false,
      isBaselineEstablished,
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
      failedEndpoints: net.failedEndpoints ?? [],
      finalError: net.finalError ?? null,
      isZeroValueSuccess,
      countedAsEffectiveStable: effective,
      notCountedReason: effective ? null : reason,
    };
  });

  // 互斥分类：每个站点只能落入其中一类，总和必须等于 101。
  const effectiveSuccess = perSite.filter((s) => s.countedAsEffectiveStable).length;
  const zeroValueSuccess = perSite.filter((s) => !s.countedAsEffectiveStable && s.isZeroValueSuccess).length;
  const partial = perSite.filter((s) => !s.countedAsEffectiveStable && !s.isZeroValueSuccess && s.status === 'partial').length;
  const failed = perSite.filter((s) => !s.countedAsEffectiveStable && !s.isZeroValueSuccess && s.status !== 'partial').length;

  const rawTechnicalSuccess = perSite.filter((s) => s.status === 'success').length;

  const totalEndpoints = perSite.reduce((sum, s) => sum + (s.sitemapEndpointCount || 0), 0);
  const totalPageUrls = perSite.reduce((sum, s) => sum + (s.pageUrlCount || 0), 0);
  const totalRequests = perSite.reduce((sum, s) => sum + s.network.totalRequests, 0);
  const totalRetries = perSite.reduce((sum, s) => sum + s.network.retryCount, 0);
  const totalTimeouts = perSite.reduce((sum, s) => sum + s.network.timeouts, 0);
  const total429 = perSite.reduce((sum, s) => sum + s.network.count429, 0);
  const total403 = perSite.reduce((sum, s) => sum + s.network.count403, 0);
  const total5xx = perSite.reduce((sum, s) => sum + s.network.count5xx, 0);
  const durations = perSite.filter((s) => s.durationMs != null).map((s) => ({ site_id: s.site_id, ms: s.durationMs }));
  const slowest = durations.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null);
  const avgDurationMs = durations.length ? Math.round(durations.reduce((sum, d) => sum + d.ms, 0) / durations.length) : 0;

  const nonGameCount = db.prepare(`SELECT COUNT(*) AS n FROM url_classifications WHERE run_id = ? AND page_type = 'non_game'`).get(collectResult.runId).n;
  const unknownCount = db.prepare(`SELECT COUNT(*) AS n FROM url_classifications WHERE run_id = ? AND page_type = 'unknown'`).get(collectResult.runId).n;

  return {
    label,
    runId: collectResult.runId,
    aggregate: {
      total: collectResult.stats.sitesTotal,
      effectiveSuccess,
      zeroValueSuccess,
      partial,
      failed,
      mutuallyExclusiveSum: effectiveSuccess + zeroValueSuccess + partial + failed,
      rawTechnicalSuccess,
      currentRoundAdmittedSuccess: collectResult.stats.sitesSuccess,
      cumulativeBaselineCompleted,
      newBaselineSiteCount: collectResult.stats.baselineSiteCount,
      addedUrlCount: collectResult.stats.addedUrlCount,
      totalEndpoints,
      totalPageUrls,
      gameHigh: gameConfidence.high,
      gameMedium: gameConfidence.medium,
      gameLow: gameConfidence.low,
      nonGameCount,
      unknownCount,
      collectDurationMs,
      avgDurationMs,
      slowestSite: slowest,
      totalRequests,
      totalRetries,
      totalTimeouts,
      total429,
      total403,
      total5xx,
      peakRssMB,
      dbSizeBeforeBytes: dbSizeBefore,
      dbSizeAfterCollectBytes: dbSizeAfterCollect,
      dbSizeFinalBytes: statSync(config.dbPath).size,
      reportDirSizeBytes: dirSizeBytes(report.dir),
    },
    perSite,
    reportDir: report.dir,
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
  const clsTotal = db.prepare('SELECT COUNT(*) AS n FROM url_classifications').get().n;
  const integrity = db.pragma('integrity_check');
  console.log(
    `\n=== 数据库最终状态 === seen_urls=${seenTotal} added_urls=${addedTotal} url_classifications=${clsTotal} integrity=${JSON.stringify(integrity)} dbPath=${config.dbPath}`,
  );

  db.close();
}

main();
