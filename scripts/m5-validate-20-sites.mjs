#!/usr/bin/env node
/**
 * Milestone 5 阶段4：20 站两轮验证（现有 10 站 + 新增 10 候选站 = 总计 20，
 * 不是再加 20 个）。复用阶段3 已经建立 baseline 的 8 个站（friv/poki/y8/
 * crazygames/coolmathgames/gogy/storytellergame/brainrot_games），
 * itch/newgrounds 仍未建立 baseline（阶段3已确认）。
 *
 * 新增 10 站选择理由见脚本内注释，覆盖：普通urlset/Sitemap Index/同域名多
 * Endpoint/大型门户/小型单游戏站/中文站/1个已知403观察站，且都有阶段1的
 * curl 可达性证据、尚未被采集器正式两轮验证过、与现有20站没有明显同后端。
 *
 * 用法：node scripts/m5-validate-20-sites.mjs
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

const EXISTING_10 = [
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

// 新增 10 站，均来自 config/sites.csv 候选池（Milestone 5 阶段1已 curl 验证可达）：
//   4399        中文/非英文大型门户（E类先验）——测试非英文站点
//   kongregate  大型游戏门户（E类先验）——扩大大型站覆盖，与现有站不同后端
//   miniclip    疑似同域名多 Endpoint（legacy 平台规则里就有专用解析规则，D类先验）
//   agame       另一个大型聚合站（E类先验），与 kongregate/miniclip 明显不同公司
//   basketrandom 小型单一游戏站（G类先验），.io 域名，补充小站多样性
//   armorgames  已知 403 观察站（F类先验，curl 直接验证首页被拦截）——满足"至少1个不稳定站"
//   julgames    未分类小型站（G类），待验证真实结构
//   gahe        未分类小型站（G类），待验证真实结构
//   playgama    未分类中型门户（G类），待验证真实结构
//   azgames     小型区域站点（G类，.my 域名），补充地域多样性
const NEW_10 = [
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

const SITES = [...EXISTING_10, ...NEW_10];

const config = loadLocalConfig({ dbPath: join(projectRoot, 'data', 'm5-validation-20-sites.db') });

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
    // 常见路径预验证开销的粗略估算：discovery 阶段每个候选先探测一次，
    // recursive-loader 再正式抓一次已验证通过的那个——超出"1次robots.txt +
    // 实际处理的Endpoint数"之外的请求，大致就是这部分开销（含少量重定向跳转，
    // 不追求精确，只做非阻塞观察）。
    stats.estimatedDiscoveryOverhead = Math.max(0, stats.totalRequests - 1 - (result.sitemapCount || 0));
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
        estimatedDiscoveryOverhead: net.estimatedDiscoveryOverhead ?? 0,
      },
      failedEndpoints: net.failedEndpoints ?? [],
    };
  });

  const totalEndpoints = perSite.reduce((sum, s) => sum + (s.sitemapEndpointCount || 0), 0);
  const totalPageUrls = perSite.reduce((sum, s) => sum + (s.pageUrlCount || 0), 0);
  const totalRequests = perSite.reduce((sum, s) => sum + s.network.totalRequests, 0);
  const totalRetries = perSite.reduce((sum, s) => sum + s.network.retryCount, 0);
  const totalTimeouts = perSite.reduce((sum, s) => sum + s.network.timeouts, 0);
  const total429 = perSite.reduce((sum, s) => sum + s.network.count429, 0);
  const total5xx = perSite.reduce((sum, s) => sum + s.network.count5xx, 0);
  const durations = perSite.filter((s) => s.durationMs != null).map((s) => ({ site_id: s.site_id, ms: s.durationMs }));
  const slowest = durations.reduce((a, b) => (b.ms > (a?.ms ?? -1) ? b : a), null);
  const avgDurationMs = durations.length ? Math.round(durations.reduce((sum, d) => sum + d.ms, 0) / durations.length) : 0;

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
      addedUrlCount: collectResult.stats.addedUrlCount,
      totalEndpoints,
      totalPageUrls,
      gameHigh: gameConfidence.high,
      gameMedium: gameConfidence.medium,
      gameLow: gameConfidence.low,
      unknownCount,
      collectDurationMs,
      avgDurationMs,
      slowestSite: slowest,
      totalRequests,
      totalRetries,
      totalTimeouts,
      total429,
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

  console.log('=== ROUND 1 ===');
  const round1 = await runRound(db, 'round1');
  console.log(JSON.stringify(round1, null, 2));

  console.log('\n=== ROUND 2: 短时间内重跑 ===');
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
