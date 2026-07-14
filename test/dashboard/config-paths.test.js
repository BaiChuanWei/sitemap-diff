import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { createDashboardServer } from '../../src/dashboard/server.js';

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
    const config = loadLocalConfig({ dbPath: join(dir, 'test.db'), outputDir: join(dir, 'output') });
    const port = 28711 + Math.floor(Math.random() * 500);
    const dashboard = createDashboardServer({ config, port });
    try {
      await dashboard.listen();
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
