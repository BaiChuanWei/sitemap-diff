#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { loadLocalConfig, parseSitesCsv } from '../src/config.js';
import { openDb, syncSites } from '../src/db/index.js';

/**
 * Milestone 1 本地入口骨架。
 *
 * 目前只做三件事：加载本地配置、初始化 SQLite（跑迁移）、把站点清单
 * CSV 同步进 sites 表。不抓取任何 sitemap —— Sitemap 采集器是
 * Milestone 2 的范围，这里刻意不实现，避免在基线阶段就触碰核心 Diff 逻辑。
 */
function main() {
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
    console.log('Milestone 2（Sitemap 采集器）尚未实现，本次运行不会抓取任何站点。');
  } finally {
    db.close();
  }
}

main();
