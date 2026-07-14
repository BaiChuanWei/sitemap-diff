#!/usr/bin/env node
/**
 * Milestone 5 阶段5：50 站两轮验证（现有 20 站 + 新增 30 候选站 = 总计 50，
 * 不是再加 50 个）。复用阶段4 已经建立 baseline 的 11 个站，其余 9 个既有
 * 观察站（itch/newgrounds/4399/kongregate/agame/armorgames/gahe/playgama/
 * azgames）仍未建立 baseline。
 *
 * 新增 30 站选择理由见阶段报告，覆盖：≥18 个有 robots.txt/Sitemap 声明的
 * 高概率站、5 个小型/单游戏站、4 个大型门户、3 个非英语/区域站、3 个已知
 * 403/结构异常观察站；均已用 curl 完成轻量预检查（可达性/robots.txt/
 * Sitemap声明/是否重定向到已测站点/是否停放），排除死站和重复后端。
 *
 * 用法：node scripts/m5-validate-50-sites.mjs
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

const EXISTING_20 = [
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
  { site_id: '4399', domain: '4399.com' },
  { site_id: 'kongregate', domain: 'kongregate.com' },
  { site_id: 'miniclip', domain: 'miniclip.com' },
  { site_id: 'agame', domain: 'agame.com' },
  { site_id: 'basketrandom', domain: 'basketrandom.io' },
  { site_id: 'armorgames', domain: 'armorgames.com' },
  { site_id: 'julgames', domain: 'julgames.com' },
  { site_id: 'gahe', domain: 'gahe.com' },
  { site_id: 'playgama', domain: 'playgama.com' },
  { site_id: 'azgames', domain: 'azgames.my' },
];

// 新增 30 站（均来自 config/sites.csv 候选池，curl 轻量预检查已确认可达、
// 不是死站/停放站/重定向到已测站点）：
//   大型门户/多Endpoint（4）：a10 kizi twoplayergames addictinggames
//   小型/单游戏站（5）：dinogame papas_games animalbrainrot crazygamesplay toytheater
//   非英语/区域站（3）：vseigru(俄语) juegos(西语) spel(荷兰语)
//   已知403/结构异常观察站（3）：minijuegos silvergames kbhgames
//   高概率可用站（其余15，均有robots.txt/Sitemap声明或既有curl证据）：
//     gamepix html5games lagged pacogames playhop gamezipper gamewolf
//     iogamesonline titotu startgamer mathplayground abcya famobi
//     playagame kiz10
const NEW_30 = [
  { site_id: 'a10', domain: 'a10.com' },
  { site_id: 'kizi', domain: 'kizi.com' },
  { site_id: 'twoplayergames', domain: 'twoplayergames.org' },
  { site_id: 'addictinggames', domain: 'addictinggames.com' },
  { site_id: 'dinogame', domain: 'dinogame.gg' },
  { site_id: 'papas_games', domain: 'papas-games.io' },
  { site_id: 'animalbrainrot', domain: 'animalbrainrot.com' },
  { site_id: 'crazygamesplay', domain: 'crazygamesplay.com' },
  { site_id: 'toytheater', domain: 'toytheater.com' },
  { site_id: 'vseigru', domain: 'vseigru.net' },
  { site_id: 'juegos', domain: 'juegos.com' },
  { site_id: 'spel', domain: 'spel.nl' },
  { site_id: 'minijuegos', domain: 'minijuegos.com' },
  { site_id: 'silvergames', domain: 'silvergames.com' },
  { site_id: 'kbhgames', domain: 'kbhgames.com' },
  { site_id: 'gamepix', domain: 'gamepix.com' },
  { site_id: 'html5games', domain: 'html5games.com' },
  { site_id: 'lagged', domain: 'lagged.com' },
  { site_id: 'pacogames', domain: 'pacogames.com' },
  { site_id: 'playhop', domain: 'playhop.com' },
  { site_id: 'gamezipper', domain: 'gamezipper.com' },
  { site_id: 'gamewolf', domain: 'gamewolf.games' },
  { site_id: 'iogamesonline', domain: 'iogamesonline.com' },
  { site_id: 'titotu', domain: 'titotu.io' },
  { site_id: 'startgamer', domain: 'startgamer.net' },
  { site_id: 'mathplayground', domain: 'mathplayground.com' },
  { site_id: 'abcya', domain: 'abcya.com' },
  { site_id: 'famobi', domain: 'famobi.com' },
  { site_id: 'playagame', domain: 'playagame.io' },
  { site_id: 'kiz10', domain: 'kiz10.com' },
];

const SITES = [...EXISTING_20, ...NEW_30];

const config = loadLocalConfig({ dbPath: join(projectRoot, 'data', 'm5-validation-50-sites.db') });

function makeInstrumentedCollectSiteFn(perSiteStats) {
  return async (params) => {
    const stats = { totalRequests: 0, count429: 0, count403: 0, count5xx: 0, timeouts: 0 };
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
    stats.failedEndpoints = result.failedSitemaps.map((e) => ({
      url: e.url,
      httpStatus: e.httpStatus,
      errorCode: e.errorCode,
      errorMessage: e.errorMessage,
    }));
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

  const gameConfidenceRows = db
    .prepare(
      `SELECT confidence, COUNT(*) AS n FROM url_classifications WHERE run_id = ? AND page_type = 'game' GROUP BY confidence`,
    )
    .all(collectResult.runId);
  const gameConfidence = { high: 0, medium: 0, low: 0 };
  for (const r of gameConfidenceRows) gameConfidence[r.confidence] = r.n;

  const perSite = SITES.map((s) => {
    const scr = db
      .prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? AND site_id = ?')
      .get(collectResult.runId, s.site_id);
    const outcome = collectResult.siteOutcomes.find((o) => o.siteId === s.site_id);
    const net = perSiteStats.get(s.site_id) || {};
    const stable = scr?.status === 'success' && !!scr?.complete && !scr?.truncated;
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
        count403: net.count403 ?? 0,
        count5xx: net.count5xx ?? 0,
      },
      failedEndpoints: net.failedEndpoints ?? [],
      finalError: net.finalError ?? null,
      countedAsStable: stable,
    };
  });

  const totalEndpoints = perSite.reduce((sum, s) => sum + (s.sitemapEndpointCount || 0), 0);
  const totalPageUrls = perSite.reduce((sum, s) => sum + (s.pageUrlCount || 0), 0);
  const totalRequests = perSite.reduce((sum, s) => sum + s.network.totalRequests, 0);
  const totalRetries = perSite.reduce((sum, s) => sum + s.network.retryCount, 0);
  const totalTimeouts = perSite.reduce((sum, s) => sum + s.network.timeouts, 0);
  const total429 = perSite.reduce((sum, s) => sum + s.network.count429, 0);
  const total403 = perSite.reduce((sum, s) => sum + s.network.count403, 0);
  const total5xx = perSite.reduce((sum, s) => sum + s.network.count5xx, 0);
  const stableSupportedSiteCount = perSite.filter((s) => s.countedAsStable).length;
  const durations = perSite.filter((s) => s.durationMs != null).map((s) => ({ site_id: s.site_id, ms: s.durationMs }));
  const slowest = durations.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null);
  const avgDurationMs = durations.length ? Math.round(durations.reduce((sum, d) => sum + d.ms, 0) / durations.length) : 0;

  const nonGameCount = db
    .prepare(`SELECT COUNT(*) AS n FROM url_classifications WHERE run_id = ? AND page_type = 'non_game'`)
    .get(collectResult.runId).n;
  const unknownCount = db
    .prepare(`SELECT COUNT(*) AS n FROM url_classifications WHERE run_id = ? AND page_type = 'unknown'`)
    .get(collectResult.runId).n;

  return {
    label,
    runId: collectResult.runId,
    aggregate: {
      total: collectResult.stats.sitesTotal,
      success: collectResult.stats.sitesSuccess,
      partial: collectResult.stats.sitesPartial,
      failed: collectResult.stats.sitesFailed,
      baselineSiteCount: collectResult.stats.baselineSiteCount,
      stableSupportedSiteCount,
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
      dbSizeBytes: statSync(config.dbPath).size,
      reportDirSizeBytes: dirSizeBytes(report.dir),
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

  // ROUND1_ONLY=1 或 ROUND2_ONLY=1 用于分开跑两轮（避免超时中断后重复浪费已完成的一轮）。
  const skipRound1 = process.env.ROUND2_ONLY === '1';
  const skipRound2 = process.env.ROUND1_ONLY === '1';

  let round1 = null;
  if (!skipRound1) {
    console.log('=== ROUND 1 ===');
    round1 = await runRound(db, 'round1');
    console.log(JSON.stringify(round1, null, 2));
  }

  let round2 = null;
  if (!skipRound2) {
    console.log('\n=== ROUND 2: 短时间内重跑 ===');
    round2 = await runRound(db, 'round2');
    console.log(JSON.stringify(round2, null, 2));
  }

  const seenTotal = db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n;
  const addedTotal = db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n;
  const clsTotal = db.prepare('SELECT COUNT(*) AS n FROM url_classifications').get().n;
  console.log(
    `\n=== 数据库最终状态 === seen_urls=${seenTotal} added_urls=${addedTotal} url_classifications=${clsTotal} dbPath=${config.dbPath}`,
  );

  db.close();
}

main();
