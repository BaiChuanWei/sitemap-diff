import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, 'migrations');

/**
 * 打开（必要时创建）本地 SQLite 数据库文件，并执行所有尚未应用的迁移。
 * 迁移是幂等的：重复调用 openDb 不会重复执行已经记录在
 * schema_migrations 里的迁移版本。
 */
export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version),
  );

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.up.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.up\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    });

    try {
      applyMigration();
    } catch (error) {
      throw new Error(`迁移 ${version} 执行失败: ${error.message}`);
    }
  }
}

/** 返回已应用的迁移版本号列表（按应用顺序），供测试和诊断使用。 */
export function listAppliedMigrations(db) {
  return db
    .prepare('SELECT version FROM schema_migrations ORDER BY applied_at ASC')
    .all()
    .map((row) => row.version);
}

/**
 * 把站点清单 CSV 记录同步进 sites 表（upsert，幂等）。
 * 返回本次同步的统计：总数、新增数、更新数。
 */
export function syncSites(db, records) {
  const existing = new Set(db.prepare('SELECT site_id FROM sites').all().map((r) => r.site_id));

  const upsert = db.prepare(`
    INSERT INTO sites (site_id, domain, priority, enabled, robots_url, sitemap_url, expected_game_path, notes, updated_at)
    VALUES (@site_id, @domain, @priority, @enabled, @robots_url, @sitemap_url, @expected_game_path, @notes, datetime('now'))
    ON CONFLICT(site_id) DO UPDATE SET
      domain              = excluded.domain,
      priority             = excluded.priority,
      enabled              = excluded.enabled,
      robots_url           = excluded.robots_url,
      sitemap_url           = excluded.sitemap_url,
      expected_game_path    = excluded.expected_game_path,
      notes                = excluded.notes,
      updated_at            = excluded.updated_at
  `);

  let inserted = 0;
  let updated = 0;

  const tx = db.transaction((rows) => {
    for (const row of rows) {
      if (!row.site_id) continue;
      upsert.run({
        site_id: row.site_id,
        domain: row.domain || '',
        priority: row.priority || null,
        enabled: row.enabled === 'true' || row.enabled === '1' ? 1 : 0,
        robots_url: row.robots_url || null,
        sitemap_url: row.sitemap_url || null,
        expected_game_path: row.expected_game_path || null,
        notes: row.notes || null,
      });
      if (existing.has(row.site_id)) {
        updated++;
      } else {
        inserted++;
      }
    }
  });
  tx(records);

  return { total: records.length, inserted, updated };
}

export function sitesDbFileExists(dbPath) {
  return existsSync(dbPath);
}
