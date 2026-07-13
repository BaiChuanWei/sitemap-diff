#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLocalConfig, parseSitesCsv } from '../src/config.js';
import { openDb, syncSites } from '../src/db/index.js';
import { collectSite } from '../src/sitemap/collector.js';

/**
 * 本地入口。
 *
 * 默认行为（Milestone 1）：加载本地配置、初始化 SQLite（跑迁移）、把站点
 * 清单 CSV 同步进 sites 表。不抓取任何 sitemap。
 *
 * `--inspect-site <site_id>` / `--inspect-url <url>`（Milestone 2）：只做
 * Sitemap 采集检查，打印统计信息，不写正式 SQLite URL 历史 —— 那是
 * Milestone 3 的范围。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.inspectSite) {
    await runInspectSite(args.inspectSite);
    return;
  }
  if (args.inspectUrl) {
    await runInspectUrl(args.inspectUrl);
    return;
  }

  runBaseline();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inspect-site') args.inspectSite = argv[++i];
    else if (argv[i] === '--inspect-url') args.inspectUrl = argv[++i];
  }
  return args;
}

function runBaseline() {
  const config = loadLocalConfig();

  if (!existsSync(config.sitesCsvPath)) {
    console.error(`站点清单文件不存在: ${config.sitesCsvPath}`);
    process.exitCode = 1;
    return;
  }

  const db = openDb(config.dbPath);
  try {
    const csvText = readFileSync(config.sitesCsvPath, 'utf-8');
    const records = parseSitesCsv(csvText);
    const { total, inserted, updated } = syncSites(db, records);

    console.log('本地基线就绪。');
    console.log(`  SQLite 数据库: ${config.dbPath}`);
    console.log(`  站点清单来源: ${config.sitesCsvPath}`);
    console.log(`  站点清单同步: 共 ${total} 个（新增 ${inserted}，更新 ${updated}）`);
    console.log(`  报告输出目录: ${config.outputDir}（尚未生成，Milestone 4 才会写入）`);
    console.log('');
    console.log('用 --inspect-site <site_id> 或 --inspect-url <url> 可以只做 Sitemap 采集检查（Milestone 2），不会写入正式 URL 历史。');
  } finally {
    db.close();
  }
}

async function runInspectSite(siteId) {
  const config = loadLocalConfig();
  if (!existsSync(config.sitesCsvPath)) {
    console.error(`站点清单文件不存在: ${config.sitesCsvPath}`);
    process.exitCode = 1;
    return;
  }

  const records = parseSitesCsv(readFileSync(config.sitesCsvPath, 'utf-8'));
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
  console.log(`耗时: ${result.durationMs}ms`);

  if (result.errors.length === 0) {
    console.log('错误摘要: 无');
    return;
  }
  console.log('错误摘要:');
  const shown = result.errors.slice(0, 10);
  for (const err of shown) {
    console.log(`  - ${err.url || '(无 URL)'}: [${err.code}] ${err.message}`);
  }
  if (result.errors.length > shown.length) {
    console.log(`  ...以及另外 ${result.errors.length - shown.length} 个错误`);
  }
}

function writeDebugFile(config, result, label) {
  const debugDir = join(config.outputDir, 'debug');
  mkdirSync(debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(debugDir, `${stamp}-${label}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
  console.log('');
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
