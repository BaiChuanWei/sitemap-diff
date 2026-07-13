#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadLocalConfig, parseSitesCsv } from '../src/config.js';
import { openDb, syncSites } from '../src/db/index.js';
import { collectSite } from '../src/sitemap/collector.js';
import { runCollect } from '../src/collect-runner.js';
import { getDbStatus } from '../src/storage/index.js';
import { acquireLock, releaseLock } from '../src/lock.js';

/**
 * 本地入口。
 *
 * 默认（无参数）：加载配置、初始化 SQLite、同步站点清单（Milestone 1 行为）。
 *
 * Milestone 3：
 *   --collect            采集全部启用站点，写入正式 URL 历史（带运行锁）
 *   --collect --site <id> 只采集指定站点
 *   --db-status          打印数据库状态
 *
 * Milestone 2（只做采集检查，不写正式 URL 历史）：
 *   --inspect-site <id>
 *   --inspect-url <url>
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.inspectSite) return runInspectSite(args.inspectSite);
  if (args.inspectUrl) return runInspectUrl(args.inspectUrl);
  if (args.dbStatus) return runDbStatus();
  if (args.collect) return runCollectCommand(args.site);

  return runBaseline();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--inspect-site') args.inspectSite = argv[++i];
    else if (a === '--inspect-url') args.inspectUrl = argv[++i];
    else if (a === '--collect') args.collect = true;
    else if (a === '--site') args.site = argv[++i];
    else if (a === '--db-status') args.dbStatus = true;
  }
  return args;
}

function loadRecords(config) {
  if (!existsSync(config.sitesCsvPath)) {
    console.error(`站点清单文件不存在: ${config.sitesCsvPath}`);
    process.exitCode = 1;
    return null;
  }
  return parseSitesCsv(readFileSync(config.sitesCsvPath, 'utf-8'));
}

function runBaseline() {
  const config = loadLocalConfig();
  const records = loadRecords(config);
  if (!records) return;

  const db = openDb(config.dbPath);
  try {
    const { total, inserted, updated } = syncSites(db, records);
    console.log('本地基线就绪。');
    console.log(`  SQLite 数据库: ${config.dbPath}`);
    console.log(`  站点清单来源: ${config.sitesCsvPath}`);
    console.log(`  站点清单同步: 共 ${total} 个（新增 ${inserted}，更新 ${updated}）`);
    console.log('');
    console.log('可用命令：');
    console.log('  --collect [--site <id>]   采集并写入正式 URL 历史（Milestone 3）');
    console.log('  --db-status               查看数据库状态');
    console.log('  --inspect-site <id> / --inspect-url <url>   只做采集检查，不写正式历史（Milestone 2）');
  } finally {
    db.close();
  }
}

async function runCollectCommand(siteFilter) {
  const config = loadLocalConfig();
  const records = loadRecords(config);
  if (!records) return;

  const db = openDb(config.dbPath);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // 先同步站点清单，再获取运行锁，避免 Windows 任务计划程序重叠执行。
  syncSites(db, records);

  const lock = acquireLock(config.lockPath, { runId, startedAt });
  if (!lock.acquired) {
    const holder = lock.holder || {};
    console.error(`另一个采集进程正在运行（pid=${holder.pid ?? '?'}, runId=${holder.runId ?? '?'}, 起于 ${holder.startedAt ?? '?'}），本次安全退出。`);
    db.close();
    process.exitCode = 0;
    return;
  }

  try {
    let sites = db.prepare('SELECT * FROM sites WHERE enabled = 1').all();
    if (siteFilter) {
      sites = sites.filter((s) => s.site_id === siteFilter);
      if (sites.length === 0) {
        console.error(`没有找到启用的站点 site_id=${siteFilter}（可能未启用或不在清单中）`);
        process.exitCode = 1;
        return;
      }
    }

    console.log(`开始采集 ${sites.length} 个站点（runId=${runId}）...`);
    const result = await runCollect(db, { sites, runId, collectSiteFn: collectSite });

    const s = result.stats;
    console.log('');
    console.log('采集完成。');
    console.log(`  整体状态: ${result.status}`);
    console.log(`  站点: 共 ${s.sitesTotal}（成功 ${s.sitesSuccess}，partial ${s.sitesPartial}，失败 ${s.sitesFailed}）`);
    console.log(`  本轮 baseline: ${s.baselineSiteCount} 个站点，${s.baselineUrlCount} 个 URL`);
    console.log(`  本轮新增 URL: ${s.addedUrlCount}`);
    for (const o of result.siteOutcomes) {
      const extra = o.status === 'success' ? (o.isBaseline ? '（baseline）' : `（新增 ${o.added}）`) : '';
      console.log(`    - ${o.siteId}: ${o.status}${extra}`);
    }
  } finally {
    releaseLock(config.lockPath, runId);
    db.close();
  }
}

function runDbStatus() {
  const config = loadLocalConfig();
  const db = openDb(config.dbPath);
  try {
    const st = getDbStatus(db);
    console.log('数据库状态');
    console.log(`  数据库文件: ${config.dbPath}`);
    console.log(`  配置站点数: ${st.siteCount}（启用 ${st.enabledCount}）`);
    console.log(`  已完成 baseline 的站点数: ${st.baselineCount}`);
    console.log(`  seen URL 总数: ${st.seenUrlCount}`);
    console.log(`  added URL 总数: ${st.addedUrlCount}`);
    if (st.lastRun) {
      console.log(`  最近一次运行: runId=${st.lastRun.run_id} 状态=${st.lastRun.status ?? '?'} 起=${st.lastRun.started_at} 止=${st.lastRun.finished_at ?? '(未结束)'}`);
      console.log(`               成功 ${st.lastRun.sites_success} / partial ${st.lastRun.sites_partial} / 失败 ${st.lastRun.sites_failed}，新增 ${st.lastRun.added_url_count}`);
    } else {
      console.log('  最近一次运行: 无');
    }
    console.log(`  最近成功站点: ${st.recentSuccess.map((r) => `${r.site_id}(${r.last_success_at})`).join(', ') || '无'}`);
    console.log(`  最近失败站点: ${st.recentFailed.map((r) => `${r.site_id}(${r.last_status})`).join(', ') || '无'}`);
  } finally {
    db.close();
  }
}

async function runInspectSite(siteId) {
  const config = loadLocalConfig();
  const records = loadRecords(config);
  if (!records) return;

  const site = records.find((r) => r.site_id === siteId);
  if (!site) {
    console.error(`站点清单里找不到 site_id=${siteId}（清单来源: ${config.sitesCsvPath}）`);
    process.exitCode = 1;
    return;
  }

  const baseUrl = site.domain ? `https://${site.domain}` : undefined;
  const result = await collectSite({
    siteId: site.site_id,
    domain: site.domain || null,
    baseUrl,
    manualSitemapUrl: site.sitemap_url || undefined,
  });

  printSummary(result, site.site_id);
  writeDebugFile(config, result, site.site_id);
  process.exitCode = result.status === 'failed' ? 1 : 0;
}

async function runInspectUrl(url) {
  const config = loadLocalConfig();
  const result = await collectSite({ manualSitemapUrl: url });

  printSummary(result, safeLabel(url));
  writeDebugFile(config, result, safeLabel(url));
  process.exitCode = result.status === 'failed' ? 1 : 0;
}

function printSummary(result, label) {
  const successCount = result.processedSitemaps.filter((e) => e.status === 'success').length;
  const failedCount = result.failedSitemaps.length;

  console.log(`站点: ${result.siteId || result.domain || label}`);
  console.log(`发现的 Sitemap 数: ${result.discoveredSitemaps.length}`);
  console.log(`成功 Endpoint 数: ${successCount}`);
  console.log(`失败 Endpoint 数: ${failedCount}`);
  console.log(`页面 URL 数: ${result.pageUrlCount}`);
  console.log(`状态: ${result.status}`);
  console.log(`完整(complete): ${result.complete} / 截断(truncated): ${result.truncated}${result.truncationReasons.length ? ` [${result.truncationReasons.join(', ')}]` : ''}`);
  console.log(`耗时: ${result.durationMs}ms`);

  if (result.errors.length === 0) {
    console.log('错误摘要: 无');
  } else {
    console.log('错误摘要:');
    const shown = result.errors.slice(0, 10);
    for (const err of shown) console.log(`  - ${err.url || '(无 URL)'}: [${err.code}] ${err.message}`);
    if (result.errors.length > shown.length) console.log(`  ...以及另外 ${result.errors.length - shown.length} 个错误`);
  }
  console.log('');
  console.log('（inspect 命令只做采集检查，不写正式 URL 历史。）');
}

function writeDebugFile(config, result, label) {
  const debugDir = join(config.outputDir, 'debug');
  mkdirSync(debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(debugDir, `${stamp}-${label}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`调试结果已写入: ${filePath}`);
}

function safeLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'inspect-url';
  }
}

main();
