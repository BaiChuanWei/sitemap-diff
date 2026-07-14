#!/usr/bin/env node
/**
 * Milestone 5 阶段6：101 站全池验证（现有 50 站 + 候选池剩余 51 站 = 总计
 * 101，即 config/sites.csv 的全部候选站，不是在 50 站之外再加 51 个、也
 * 不裁剪到 100 个）。
 *
 * 新增 51 站均来自 config/sites.csv 尚未测试的行，已用 curl 完成轻量预检查
 * （首页可达性、robots.txt、Sitemap 声明、是否重定向/重复后端），51 个全部
 * 可达、robots.txt 均可访问、Sitemap 声明或站点结构互不相同，无需排除。
 * 其中 freeonlinegames/gameflare/speeleiland/spelle 首页直接返回 403（与
 * armorgames/animalbrainrot 同类已知拦截模式），仍纳入正式验证观察其结果，
 * 不预先排除、不预先计入失败。
 *
 * 用法：node scripts/m5-validate-101-sites.mjs
 *   ROUND1_ONLY=1 / ROUND2_ONLY=1 可分开跑两轮，避免超时中断后重复浪费。
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

const EXISTING_50 = [
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

// 新增 51 站：config/sites.csv 候选池中此前从未测试过的全部剩余行。
const NEW_51 = [
  { site_id: 'crazygames_2', domain: 'crazygames.org' },
  { site_id: '7k7k', domain: '7k7k.com' },
  { site_id: 'gamejolt', domain: 'gamejolt.com' },
  { site_id: 'gamesgames', domain: 'gamesgames.com' },
  { site_id: '1001games', domain: '1001games.com' },
  { site_id: '4j', domain: '4j.com' },
  { site_id: 'amzgame', domain: 'amzgame.com' },
  { site_id: 'bestgames', domain: 'bestgames.com' },
  { site_id: 'coolgames', domain: 'coolgames.com' },
  { site_id: 'coolmath4kids', domain: 'coolmath4kids.com' },
  { site_id: 'easegame', domain: 'easegame.com' },
  { site_id: 'fastplaygames', domain: 'fastplaygames.com' },
  { site_id: 'flipline', domain: 'flipline.com' },
  { site_id: 'flyordie', domain: 'flyordie.com' },
  { site_id: 'freegames', domain: 'freegames.com' },
  { site_id: 'freegames_2', domain: 'freegames.io' },
  { site_id: 'freegames_3', domain: 'freegames.org' },
  { site_id: 'funhtml5games', domain: 'funhtml5games.com' },
  { site_id: 'funnygames', domain: 'funnygames.org' },
  { site_id: 'gamaverse', domain: 'gamaverse.com' },
  { site_id: 'gameforge', domain: 'gameforge.com' },
  { site_id: 'gamesbx', domain: 'gamesbx.com' },
  { site_id: 'gamesfreak', domain: 'gamesfreak.net' },
  { site_id: 'gamesnacks', domain: 'gamesnacks.com' },
  { site_id: 'gamessumo', domain: 'gamessumo.com' },
  { site_id: 'girlgames', domain: 'girlgames.space' },
  { site_id: 'girlgames_2', domain: 'girlgames.com' },
  { site_id: 'girlgogames', domain: 'girlgogames.org' },
  { site_id: 'hoodamath', domain: 'hoodamath.com' },
  { site_id: 'io_games', domain: 'io-games.io' },
  { site_id: 'iogames', domain: 'iogames.space' },
  { site_id: 'iogames_2', domain: 'iogames.games' },
  { site_id: 'kizi1000', domain: 'kizi1000.com' },
  { site_id: 'mathgames', domain: 'mathgames.com' },
  { site_id: 'miniplay', domain: 'miniplay.com' },
  { site_id: 'mousebreaker', domain: 'mousebreaker.com' },
  { site_id: 'nitrome', domain: 'nitrome.com' },
  { site_id: 'onlinegames', domain: 'onlinegames.io' },
  { site_id: 'pbskids', domain: 'pbskids.org' },
  { site_id: 'playbrain', domain: 'playbrain.games' },
  { site_id: 'playmath', domain: 'playmath.org' },
  { site_id: 'plays', domain: 'plays.org' },
  { site_id: 'primarygames', domain: 'primarygames.com' },
  { site_id: 'shockwave', domain: 'shockwave.com' },
  { site_id: 'spelletjes', domain: 'spelletjes.nl' },
  { site_id: 'webgames', domain: 'webgames.io' },
  { site_id: 'yad', domain: 'yad.com' },
  { site_id: 'freeonlinegames', domain: 'freeonlinegames.com' },
  { site_id: 'gameflare', domain: 'gameflare.com' },
  { site_id: 'speeleiland', domain: 'speeleiland.nl' },
  { site_id: 'spelle', domain: 'spelle.nl' },
];

const SITES = [...EXISTING_50, ...NEW_51];

// 已知"技术成功但零真实内容"的站点：status=success 且 pageUrlCount>0，但内容
// 实为占位/错误页而非真实可监控 URL。目前只有 html5games.com 一例，且它本身
// pageUrlCount=0 会被自动规则排除，这里留空表示暂无需要人工特殊排除的站点；
// 若 101 站验证中发现新的同类站点，必须先有实测证据才能加入本清单。
const KNOWN_FAKE_CONTENT_DESPITE_NONZERO_COUNT = new Set([]);

const config = loadLocalConfig({ dbPath: join(projectRoot, 'data', 'm5-validation-101-sites.db') });

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

/**
 * "有效稳定生产站"判定（严格按用户要求，不做统一最小 URL 数门槛）：
 *   status=success && complete=true && truncated=false && baseline 已建立
 *   && pageUrlCount>0（有真实 URL）&& 不在已知"零价值/伪造内容"名单里。
 * 返回 { effective, reason }：effective=false 时 reason 必须说明具体原因。
 */
function evaluateEffectiveStable({ scr, siteId, isBaselineEstablished }) {
  if (!scr) return { effective: false, reason: '本轮无 site_crawl_runs 记录' };
  if (scr.status !== 'success') return { effective: false, reason: `status=${scr.status}，非技术成功` };
  if (!scr.complete) return { effective: false, reason: 'complete=false，结果不完整' };
  if (scr.truncated) return { effective: false, reason: 'truncated=true，数据被截断' };
  if (!isBaselineEstablished) return { effective: false, reason: '尚未建立 baseline' };
  if (Number(scr.page_url_count) === 0) {
    return { effective: false, reason: 'pageUrlCount=0，技术成功但无真实可监控 URL（零价值成功）' };
  }
  if (KNOWN_FAKE_CONTENT_DESPITE_NONZERO_COUNT.has(siteId)) {
    return { effective: false, reason: 'pageUrlCount>0 但内容已实测确认为占位/错误页，非真实游戏 URL' };
  }
  return { effective: true, reason: null };
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

  const baselineSiteIds = new Set(
    db
      .prepare(`SELECT site_id FROM sites WHERE baseline_completed_at IS NOT NULL`)
      .all()
      .map((r) => r.site_id),
  );
  const cumulativeBaselineCompleted = baselineSiteIds.size;

  const perSite = SITES.map((s) => {
    const scr = db
      .prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? AND site_id = ?')
      .get(collectResult.runId, s.site_id);
    const outcome = collectResult.siteOutcomes.find((o) => o.siteId === s.site_id);
    const net = perSiteStats.get(s.site_id) || {};
    const isBaselineEstablished = baselineSiteIds.has(s.site_id);
    const { effective, reason } = evaluateEffectiveStable({ scr, siteId: s.site_id, isBaselineEstablished });
    const isZeroValueSuccess = scr?.status === 'success' && !!scr?.complete && !scr?.truncated && Number(scr?.page_url_count) === 0;
    return {
      site_id: s.site_id,
      status: scr?.status ?? null,
      complete: !!scr?.complete,
      truncated: !!scr?.truncated,
      truncationReasons: net.truncationReasons ?? [],
      sitemapEndpointCount: net.sitemapCount ?? null,
      pageUrlCount: scr?.page_url_count ?? 0,
      isBaseline: outcome?.isBaseline ?? false,
      isBaselineEstablished,
      addedUrlCount: scr?.added_url_count ?? 0,
      durationMs: scr?.duration_ms ?? null,
      attempts: net.retryCount != null ? net.retryCount + 1 : null,
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

  const totalEndpoints = perSite.reduce((sum, s) => sum + (s.sitemapEndpointCount || 0), 0);
  const totalPageUrls = perSite.reduce((sum, s) => sum + (s.pageUrlCount || 0), 0);
  const totalRequests = perSite.reduce((sum, s) => sum + s.network.totalRequests, 0);
  const totalRetries = perSite.reduce((sum, s) => sum + s.network.retryCount, 0);
  const totalTimeouts = perSite.reduce((sum, s) => sum + s.network.timeouts, 0);
  const total429 = perSite.reduce((sum, s) => sum + s.network.count429, 0);
  const total403 = perSite.reduce((sum, s) => sum + s.network.count403, 0);
  const total5xx = perSite.reduce((sum, s) => sum + s.network.count5xx, 0);
  const effectiveStableSupportedCount = perSite.filter((s) => s.countedAsEffectiveStable).length;
  const zeroValueSuccessCount = perSite.filter((s) => s.isZeroValueSuccess).length;
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
      currentRoundSuccess: collectResult.stats.sitesSuccess,
      partial: collectResult.stats.sitesPartial,
      failed: collectResult.stats.sitesFailed,
      newBaselineSiteCount: collectResult.stats.baselineSiteCount,
      cumulativeBaselineCompleted,
      effectiveStableSupportedCount,
      zeroValueSuccessCount,
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
