import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, listAppliedMigrations, syncSites } from '../src/db/index.js';
import { parseSitesCsv } from '../src/config.js';

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sitemap-diff-db-test-'));
  const dbPath = join(dir, 'local.db');
  const db = openDb(dbPath);
  try {
    fn(db, dbPath);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('openDb: 建库后 0001_baseline 迁移已应用，且 sites 表存在', () => {
  withTempDb((db) => {
    const applied = listAppliedMigrations(db);
    assert.ok(applied.includes('0001_baseline'));

    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sites'")
      .get();
    assert.ok(tableExists, 'sites 表应该存在');
  });
});

test('openDb: 重复打开同一个数据库文件不会重复应用迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sitemap-diff-db-test-'));
  const dbPath = join(dir, 'local.db');
  try {
    const db1 = openDb(dbPath);
    db1.close();
    const db2 = openDb(dbPath);
    const applied = listAppliedMigrations(db2);
    const count = applied.filter((v) => v === '0001_baseline').length;
    assert.equal(count, 1, '同一个迁移版本只应该记录一次');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncSites: 从示例 CSV 同步站点清单，首次全部是新增', () => {
  withTempDb((db) => {
    const csv = [
      'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes',
      'poki,poki.com,high,true,https://poki.com/robots.txt,,/g/,',
      'crazygames,crazygames.com,high,true,https://www.crazygames.com/robots.txt,,/game/,',
    ].join('\n');
    const records = parseSitesCsv(csv);

    const result = syncSites(db, records);
    assert.deepEqual(result, { total: 2, inserted: 2, updated: 0 });

    const rows = db.prepare('SELECT * FROM sites ORDER BY site_id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].site_id, 'crazygames');
    assert.equal(rows[0].enabled, 1);
  });
});

test('syncSites: 重复用同一份 CSV 同步是幂等的（不产生重复行，第二次全部是更新）', () => {
  withTempDb((db) => {
    const csv = [
      'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes',
      'poki,poki.com,high,true,,,,',
    ].join('\n');
    const records = parseSitesCsv(csv);

    const first = syncSites(db, records);
    assert.deepEqual(first, { total: 1, inserted: 1, updated: 0 });

    const second = syncSites(db, records);
    assert.deepEqual(second, { total: 1, inserted: 0, updated: 1 });

    const rows = db.prepare('SELECT * FROM sites').all();
    assert.equal(rows.length, 1, '重复同步不应该产生重复行');
  });
});

test('syncSites: enabled=false 的站点存成 0', () => {
  withTempDb((db) => {
    const csv = [
      'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes',
      'x,x.com,low,false,,,,',
    ].join('\n');
    syncSites(db, parseSitesCsv(csv));

    const row = db.prepare('SELECT enabled FROM sites WHERE site_id = ?').get('x');
    assert.equal(row.enabled, 0);
  });
});
