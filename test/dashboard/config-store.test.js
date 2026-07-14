import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig, parseCsvWithHeaders } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import {
  loadConfigSnapshot,
  computeConfigVersion,
  writeConfig,
  ConfigVersionConflictError,
  ConfigLockedError,
} from '../../src/dashboard/config-store.js';

const SITES_HEADER = 'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes,site_category';

function withTempConfig(fn, { seedSites = true } = {}) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-store-'));
    const config = loadLocalConfig({
      dbPath: join(dir, 'test.db'),
      sitesCsvPath: join(dir, 'sites.csv'),
      siteLimitsCsvPath: join(dir, 'site-limits.csv'),
      siteSitemapsCsvPath: join(dir, 'site-sitemaps.csv'),
    });
    if (seedSites) {
      writeFileSync(config.sitesCsvPath, `${SITES_HEADER}\npoki,poki.com,high,true,,,,,\n`, 'utf-8');
    }
    try {
      await fn({ dir, config });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('loadConfigSnapshot：文件不存在时返回空快照，不抛错', withTempConfig(async ({ config }) => {
  const snap = loadConfigSnapshot(config);
  assert.deepEqual(snap.sites.rows, [{ site_id: 'poki', domain: 'poki.com', priority: 'high', enabled: 'true', robots_url: '', sitemap_url: '', expected_game_path: '', notes: '', site_category: '' }]);
  assert.deepEqual(snap.limits.rows, []);
  assert.deepEqual(snap.sitemaps.rows, []);
  assert.ok(snap.configVersion);
}, { seedSites: true }));

test('computeConfigVersion：内容相同则版本相同，内容不同则版本不同', () => {
  const a = computeConfigVersion({ sitesText: 'x', limitsText: '', sitemapsText: '' });
  const b = computeConfigVersion({ sitesText: 'x', limitsText: '', sitemapsText: '' });
  const c = computeConfigVersion({ sitesText: 'y', limitsText: '', sitemapsText: '' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('writeConfig：版本号不匹配时抛 ConfigVersionConflictError（409 场景）', withTempConfig(async ({ config }) => {
  await assert.rejects(
    async () =>
      writeConfig(config, {
        expectedConfigVersion: 'stale-version',
        mutate: (snap) => snap,
      }),
    ConfigVersionConflictError,
  );
}));

test('writeConfig：成功写入后重新计算的版本号会变化', withTempConfig(async ({ config }) => {
  const before = loadConfigSnapshot(config);
  const result = writeConfig(config, {
    expectedConfigVersion: before.configVersion,
    mutate: (snap) => ({
      sites: { headers: snap.sites.headers, rows: [...snap.sites.rows, { site_id: 'newsite', domain: 'newsite.com', priority: 'medium', enabled: 'true', robots_url: '', sitemap_url: '', expected_game_path: '', notes: '', site_category: '' }] },
    }),
  });
  assert.notEqual(result.configVersion, before.configVersion);

  const after = loadConfigSnapshot(config);
  assert.equal(after.sites.rows.length, 2);
  assert.ok(after.sites.rows.some((r) => r.site_id === 'newsite'));
}));

test('writeConfig：写入失败时整体回滚，不留下半份 CSV', withTempConfig(async ({ config }) => {
  const before = loadConfigSnapshot(config);
  const beforeSitesText = readFileSync(config.sitesCsvPath, 'utf-8');

  let callCount = 0;
  const fsImpl = {
    writeFileSync: (path, text, enc) => {
      callCount++;
      if (callCount === 2) throw new Error('模拟磁盘写入失败');
      writeFileSync(path, text, enc);
    },
  };

  await assert.rejects(
    async () =>
      writeConfig(config, {
        expectedConfigVersion: before.configVersion,
        mutate: (snap) => ({
          sites: { headers: snap.sites.headers, rows: [{ ...snap.sites.rows[0], notes: '改过了' }] },
          limits: { headers: ['site_id', 'max_download_bytes'], rows: [{ site_id: 'poki', max_download_bytes: '999' }] },
        }),
        fsImpl,
      }),
    /CONFIG_WRITE_FAILED|模拟磁盘写入失败/,
  );

  // sites.csv 必须回滚成写入前的原始内容，不能停留在"已写但对方没写"的中间态。
  const afterSitesText = readFileSync(config.sitesCsvPath, 'utf-8');
  assert.equal(afterSitesText, beforeSitesText);
  // site-limits.csv 写入前不存在，回滚后也应该不存在（不留下孤儿文件）。
  assert.equal(existsSync(config.siteLimitsCsvPath), false);
}));

test('writeConfig：syncSites 失败时回滚配置文件，文件与 SQLite 保持一致', withTempConfig(async ({ config }) => {
  const db = openDb(config.dbPath);
  try {
    const before = loadConfigSnapshot(config);
    const beforeText = readFileSync(config.sitesCsvPath, 'utf-8');

    const failingDb = {
      prepare: () => {
        throw new Error('模拟 SQLite 同步失败');
      },
    };

    await assert.rejects(
      async () =>
        writeConfig(config, {
          expectedConfigVersion: before.configVersion,
          mutate: (snap) => ({ sites: { headers: snap.sites.headers, rows: [{ ...snap.sites.rows[0], notes: 'x' }] } }),
          db: failingDb,
        }),
      (err) => err.code === 'SYNC_SITES_FAILED',
    );

    const afterText = readFileSync(config.sitesCsvPath, 'utf-8');
    assert.equal(afterText, beforeText, '配置文件应该回滚回修改前的内容');
  } finally {
    db.close();
  }
}));

test('writeConfig：成功时调用 syncSites，新站点进入 sites 表', withTempConfig(async ({ config }) => {
  const db = openDb(config.dbPath);
  try {
    const before = loadConfigSnapshot(config);
    writeConfig(config, {
      expectedConfigVersion: before.configVersion,
      mutate: (snap) => ({
        sites: {
          headers: snap.sites.headers,
          rows: [...snap.sites.rows, { site_id: 'newsite', domain: 'newsite.com', priority: 'medium', enabled: 'true', robots_url: '', sitemap_url: '', expected_game_path: '', notes: '', site_category: '' }],
        },
      }),
      db,
    });
    const row = db.prepare('SELECT * FROM sites WHERE site_id = ?').get('newsite');
    assert.ok(row);
    assert.equal(row.domain, 'newsite.com');
  } finally {
    db.close();
  }
}));

test('writeConfig：暂停站点（enabled=false）不删除任何历史', withTempConfig(async ({ config }) => {
  const db = openDb(config.dbPath);
  try {
    db.prepare(`INSERT INTO sites (site_id, domain, enabled, baseline_completed_at) VALUES ('poki','poki.com',1,'2026-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO seen_urls (site_id, original_url, normalized_url, url_hash, first_run_id, last_run_id) VALUES ('poki','https://poki.com/g/a','https://poki.com/g/a','h1','r1','r1')`).run();

    const before = loadConfigSnapshot(config);
    writeConfig(config, {
      expectedConfigVersion: before.configVersion,
      mutate: (snap) => ({
        sites: { headers: snap.sites.headers, rows: snap.sites.rows.map((r) => (r.site_id === 'poki' ? { ...r, enabled: 'false' } : r)) },
      }),
      db,
    });

    const row = db.prepare('SELECT enabled, baseline_completed_at FROM sites WHERE site_id = ?').get('poki');
    assert.equal(row.enabled, 0);
    assert.ok(row.baseline_completed_at, 'baseline 不应该被删除');
    const seenCount = db.prepare('SELECT COUNT(*) n FROM seen_urls WHERE site_id = ?').get('poki').n;
    assert.equal(seenCount, 1, 'seen_urls 不应该被删除');
  } finally {
    db.close();
  }
}));

test('对抗场景：用户手工编辑 CSV 后，面板仍带着旧 configVersion 提交会被拒绝（409）', withTempConfig(async ({ config }) => {
  const before = loadConfigSnapshot(config);
  // 模拟"用户不通过面板，直接用记事本改了 sites.csv"——这必须让 configVersion
  // 失配，而不是被面板的写操作静默覆盖掉手工修改的内容。
  writeFileSync(config.sitesCsvPath, `${SITES_HEADER}\npoki,poki.com,high,true,,,,,手工改过\n`, 'utf-8');

  await assert.rejects(
    async () =>
      writeConfig(config, {
        expectedConfigVersion: before.configVersion,
        mutate: (snap) => ({ sites: { headers: snap.sites.headers, rows: [{ ...snap.sites.rows[0], priority: 'low' }] } }),
      }),
    ConfigVersionConflictError,
  );

  // 手工修改的内容必须原样保留，没有被面板的失败写入破坏。
  const stillManual = readFileSync(config.sitesCsvPath, 'utf-8');
  assert.match(stillManual, /手工改过/);
}));

test('对抗场景：备注字段允许很长的文本（在请求体大小上限内），CSV 往返后内容不被截断', withTempConfig(async ({ config }) => {
  const longNotes = '备注'.repeat(20000); // 约 40KB 中文文本，远小于 1MB 请求体上限
  const before = loadConfigSnapshot(config);
  writeConfig(config, {
    expectedConfigVersion: before.configVersion,
    mutate: (snap) => ({ sites: { headers: snap.sites.headers, rows: [{ ...snap.sites.rows[0], notes: longNotes }] } }),
  });
  const { rows } = parseCsvWithHeaders(readFileSync(config.sitesCsvPath, 'utf-8'));
  assert.equal(rows[0].notes, longNotes);
}));

test('对抗场景：备份目录不可写时，写操作整体失败且不留下半份配置', withTempConfig(async ({ config, dir }) => {
  const backupsRoot = join(dir, 'backups');
  // 提前把 backups 建成一个"文件"而不是目录：任何往里面 mkdir 子目录的尝试
  // 都会失败，模拟"备份目录所在磁盘位置不可写/被占用"的场景。
  writeFileSync(backupsRoot, '不是目录', 'utf-8');

  const before = loadConfigSnapshot(config);
  const beforeSitesText = readFileSync(config.sitesCsvPath, 'utf-8');

  assert.throws(() =>
    writeConfig(config, {
      expectedConfigVersion: before.configVersion,
      mutate: (snap) => ({ sites: { headers: snap.sites.headers, rows: [{ ...snap.sites.rows[0], notes: '不应该写入' }] } }),
    }),
  );

  // 备份都没做成，正式配置文件更不应该被改动。
  const afterSitesText = readFileSync(config.sitesCsvPath, 'utf-8');
  assert.equal(afterSitesText, beforeSitesText);
}));

test('对抗场景：1000 条手工 Sitemap Endpoint 能正常写入并原样往返，不崩溃不截断', withTempConfig(async ({ config }) => {
  const before = loadConfigSnapshot(config);
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    site_id: 'poki',
    sitemap_url: `https://poki.com/sitemap-${i}.xml`,
    enabled: 'true',
    mode: 'merge',
    notes: '',
    verified_at: '',
  }));
  const result = writeConfig(config, {
    expectedConfigVersion: before.configVersion,
    mutate: (snap) => ({
      sitemaps: { headers: ['site_id', 'sitemap_url', 'enabled', 'mode', 'notes', 'verified_at'], rows },
    }),
  });
  assert.ok(result.configVersion);
  const { rows: reparsed } = parseCsvWithHeaders(readFileSync(config.siteSitemapsCsvPath, 'utf-8'));
  assert.equal(reparsed.length, 1000);
  assert.equal(reparsed[999].sitemap_url, 'https://poki.com/sitemap-999.xml');
}));

test('writeConfig：并发写入时第二个请求立刻收到 ConfigLockedError（503 场景）', withTempConfig(async ({ config }) => {
  const before = loadConfigSnapshot(config);
  let releaseFirstWrite;
  const gate = new Promise((r) => (releaseFirstWrite = r));

  const firstWritePromise = writeConfig(config, {
    expectedConfigVersion: before.configVersion,
    mutate: (snap) => {
      // 用同步阻塞模拟"写入过程中"占住锁的窗口——config-store 的写入本身是
      // 同步的，这里通过在 mutate 内部占住调用栈来验证锁在整个写入期间生效。
      let locked;
      try {
        writeConfig(config, { expectedConfigVersion: before.configVersion, mutate: (s) => s });
        locked = false;
      } catch (err) {
        locked = err instanceof ConfigLockedError;
      }
      assert.equal(locked, true, '写入过程中，第二次调用应该立刻被锁拒绝');
      return snap;
    },
  });
  await firstWritePromise;
}));

test('备份：写入成功后 config/backups/ 下生成 manifest.json', withTempConfig(async ({ config }) => {
  const before = loadConfigSnapshot(config);
  const { backupDir } = writeConfig(config, {
    expectedConfigVersion: before.configVersion,
    mutate: (snap) => ({ sites: { headers: snap.sites.headers, rows: [{ ...snap.sites.rows[0], notes: '改过了' }] } }),
  });

  assert.ok(existsSync(join(backupDir, 'manifest.json')));
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf-8'));
  assert.ok(manifest.createdAt);
  assert.ok(manifest.files.some((f) => f.fileName === 'sites.csv' && f.existedBefore === true));
  assert.ok(existsSync(join(backupDir, 'sites.csv')), '备份目录应该包含修改前的 sites.csv 副本');
  // manifest 不应该包含任何 secret 相关字段
  const manifestText = readFileSync(join(backupDir, 'manifest.json'), 'utf-8');
  assert.doesNotMatch(manifestText, /token/i);
}));

test('CSV 序列化写入后重新解析语义一致（含中文/逗号/引号）', withTempConfig(async ({ config }) => {
  const before = loadConfigSnapshot(config);
  writeConfig(config, {
    expectedConfigVersion: before.configVersion,
    mutate: (snap) => ({
      sites: {
        headers: snap.sites.headers,
        rows: [{ ...snap.sites.rows[0], notes: '备注，含逗号和"引号"，以及中文' }],
      },
    }),
  });
  const { rows } = parseCsvWithHeaders(readFileSync(config.sitesCsvPath, 'utf-8'));
  assert.equal(rows[0].notes, '备注，含逗号和"引号"，以及中文');
}));
