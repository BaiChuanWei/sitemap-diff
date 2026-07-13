import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb, listAppliedMigrations } from '../src/db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'src', 'db', 'migrations');

test('测试13 旧数据库（只有 0001+0002）可平滑升级到 0003', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4-mig-'));
  const dbPath = join(dir, 'local.db');
  try {
    // 手动构造一个"旧数据库"：只应用 0001 和 0002。
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    for (const v of ['0001_baseline', '0002_url_history']) {
      raw.exec(readFileSync(join(migrationsDir, `${v}.up.sql`), 'utf-8'));
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(v);
    }
    // 塞一条历史数据，验证升级不破坏它
    raw.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('poki','poki.com',1)`).run();
    raw.close();

    // 用正式入口重新打开 → 应自动应用 0003
    const db = openDb(dbPath);
    const applied = listAppliedMigrations(db);
    assert.deepEqual(applied, ['0001_baseline', '0002_url_history', '0003_url_classification']);
    const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='url_classifications'").get();
    assert.ok(tbl, 'url_classifications 表应存在');
    // 旧数据仍在
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('测试14 0003 down migration 可执行（DROP url_classifications，不影响 added/seen 约束）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4-migdown-'));
  const dbPath = join(dir, 'local.db');
  try {
    const db = openDb(dbPath);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='url_classifications'").get());

    const down = readFileSync(join(migrationsDir, '0003_url_classification.down.sql'), 'utf-8');
    db.exec(down);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='url_classifications'").get(), undefined);

    // seen_urls / added_urls 及其唯一约束仍在
    const addedSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='added_urls'").get().sql;
    assert.match(addedSql, /UNIQUE\(site_id, url_hash\)/);
    const seenSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='seen_urls'").get().sql;
    assert.match(seenSql, /UNIQUE\(site_id, url_hash\)/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移可重复管理：重复 openDb 不重复应用 0003', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4-migrepeat-'));
  const dbPath = join(dir, 'local.db');
  try {
    openDb(dbPath).close();
    const db = openDb(dbPath);
    const applied = listAppliedMigrations(db);
    assert.equal(applied.filter((v) => v === '0003_url_classification').length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
