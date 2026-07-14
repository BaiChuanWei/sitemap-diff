import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { createAndListenDashboard } from './helpers/listen-with-retry.js';

const SITES_HEADER = 'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes,site_category';

test('loadLocalConfig 在含中文的目录路径下工作正常', () => {
  const dir = mkdtempSync(join(tmpdir(), '仪表盘测试-中文路径-'));
  try {
    const config = loadLocalConfig({ dbPath: join(dir, '数据库.db'), outputDir: join(dir, '输出') });
    const db = openDb(config.dbPath);
    db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('中文站点','x.com',1)`).run();
    const row = db.prepare(`SELECT * FROM sites WHERE site_id = ?`).get('中文站点');
    assert.equal(row.site_id, '中文站点');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('面板服务在含中文的项目路径下能正常提供静态首页', async () => {
  const dir = mkdtempSync(join(tmpdir(), '面板服务-'));
  try {
    const config = loadLocalConfig({
      dbPath: join(dir, 'test.db'),
      sitesCsvPath: join(dir, 'sites.csv'),
      siteLimitsCsvPath: join(dir, 'site-limits.csv'),
      siteSitemapsCsvPath: join(dir, 'site-sitemaps.csv'),
      outputDir: join(dir, 'output'),
    });
    writeFileSync(config.sitesCsvPath, `${SITES_HEADER}\n`, 'utf-8');
    const { dashboard, port } = await createAndListenDashboard({ config });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: `127.0.0.1:${port}` } });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /Sitemap 监控面板/);
    } finally {
      await dashboard.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
