import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/index.js';
import {
  persistCompleteSiteResult,
  recordRejectedSiteResult,
  createCrawlRun,
  isAdmissible,
} from '../../src/storage/index.js';

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'm3-persist-'));
  const dbPath = join(dir, 'local.db');
  const db = openDb(dbPath);
  try {
    return fn(db, dbPath, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertSite(db, siteId = 'poki', domain = 'poki.com') {
  db.prepare(
    `INSERT INTO sites (site_id, domain, enabled) VALUES (?, ?, 1)`,
  ).run(siteId, domain);
  return { site_id: siteId, domain };
}

function completeResult(pageUrls, overrides = {}) {
  return {
    siteId: 'poki',
    domain: 'poki.com',
    status: 'success',
    complete: true,
    truncated: false,
    truncationReasons: [],
    startedAt: '2026-07-13T00:00:00.000Z',
    finishedAt: '2026-07-13T00:00:01.000Z',
    durationMs: 1000,
    discoveredSitemaps: ['https://poki.com/sitemap.xml'],
    processedSitemaps: [{ url: 'https://poki.com/sitemap.xml', status: 'success', type: 'urlset' }],
    failedSitemaps: [],
    pageUrls,
    pageUrlCount: pageUrls.length,
    sitemapCount: 1,
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function counts(db, siteId = 'poki') {
  return {
    seen: db.prepare('SELECT COUNT(*) AS n FROM seen_urls WHERE site_id = ?').get(siteId).n,
    added: db.prepare('SELECT COUNT(*) AS n FROM added_urls WHERE site_id = ?').get(siteId).n,
  };
}

const A = 'https://poki.com/g/a';
const B = 'https://poki.com/g/b';
const C = 'https://poki.com/g/c';
const D = 'https://poki.com/g/d';

test('测试1 首次 baseline：seen_urls=3，added_urls=0，baseline 已完成', () => {
  withTempDb((db) => {
    const site = insertSite(db);
    createCrawlRun(db, { runId: 'run-1', startedAt: '2026-07-13T00:00:00Z' });
    const r = persistCompleteSiteResult(db, { runId: 'run-1', site, result: completeResult([A, B, C]) });

    assert.equal(r.isBaseline, true);
    assert.equal(r.addedCount, 0, '首次 baseline 不能产生新增');
    assert.deepEqual(counts(db), { seen: 3, added: 0 });

    const siteRow = db.prepare('SELECT baseline_completed_at, last_status FROM sites WHERE site_id = ?').get('poki');
    assert.ok(siteRow.baseline_completed_at, 'baseline_completed_at 应该被设置');
    assert.equal(siteRow.last_status, 'success');
  });
});

test('测试2 新增一个 URL：第二次 [A,B,C,D] → added=D，added_urls +1', () => {
  withTempDb((db) => {
    const site = insertSite(db);
    createCrawlRun(db, { runId: 'run-1', startedAt: '2026-07-13T00:00:00Z' });
    persistCompleteSiteResult(db, { runId: 'run-1', site, result: completeResult([A, B, C]) });

    createCrawlRun(db, { runId: 'run-2', startedAt: '2026-07-13T01:00:00Z' });
    const r = persistCompleteSiteResult(db, { runId: 'run-2', site, result: completeResult([A, B, C, D]) });

    assert.equal(r.isBaseline, false);
    assert.equal(r.addedCount, 1);
    assert.deepEqual(counts(db), { seen: 4, added: 1 });

    const added = db.prepare('SELECT normalized_url FROM added_urls WHERE site_id = ?').all('poki');
    assert.deepEqual(added.map((a) => a.normalized_url), [D]);
  });
});

test('测试3 幂等：再次提交相同数据 → added=0，数据库行数不重复增长', () => {
  withTempDb((db) => {
    const site = insertSite(db);
    createCrawlRun(db, { runId: 'run-1', startedAt: 't1' });
    persistCompleteSiteResult(db, { runId: 'run-1', site, result: completeResult([A, B, C, D]) });

    createCrawlRun(db, { runId: 'run-2', startedAt: 't2' });
    persistCompleteSiteResult(db, { runId: 'run-2', site, result: completeResult([A, B, C, D]) });

    createCrawlRun(db, { runId: 'run-3', startedAt: 't3' });
    const r = persistCompleteSiteResult(db, { runId: 'run-3', site, result: completeResult([A, B, C, D]) });

    assert.equal(r.addedCount, 0);
    assert.deepEqual(counts(db), { seen: 4, added: 0 });
  });
});

test('测试4 数据库重启：关闭并重新打开 SQLite，历史仍在，相同数据 added=0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-restart-'));
  const dbPath = join(dir, 'local.db');
  try {
    let db = openDb(dbPath);
    const site = insertSite(db);
    createCrawlRun(db, { runId: 'run-1', startedAt: 't1' });
    persistCompleteSiteResult(db, { runId: 'run-1', site, result: completeResult([A, B, C]) });
    db.close();

    // 重新打开
    db = openDb(dbPath);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n, 3, '重启后历史应保留');

    createCrawlRun(db, { runId: 'run-2', startedAt: 't2' });
    const r = persistCompleteSiteResult(db, {
      runId: 'run-2',
      site: { site_id: 'poki', domain: 'poki.com' },
      result: completeResult([A, B, C]),
    });
    assert.equal(r.addedCount, 0, '重启后相同数据不应产生新增');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('测试5 partial 拒绝写入：seen_urls/added_urls 不变，站点运行记录为 partial', () => {
  withTempDb((db) => {
    const site = insertSite(db);
    // 先建立 baseline
    createCrawlRun(db, { runId: 'run-1', startedAt: 't1' });
    persistCompleteSiteResult(db, { runId: 'run-1', site, result: completeResult([A, B, C]) });
    const before = counts(db);

    // partial 结果（哪怕带 4 个 pageUrls）必须被拒绝
    const partial = completeResult([A, B, C, D], { status: 'partial', complete: false });
    assert.equal(isAdmissible(partial), false);

    createCrawlRun(db, { runId: 'run-2', startedAt: 't2' });
    recordRejectedSiteResult(db, { runId: 'run-2', site, result: partial });

    assert.deepEqual(counts(db), before, 'partial 不得改动 seen/added');
    const scr = db.prepare('SELECT status, complete FROM site_crawl_runs WHERE run_id = ?').get('run-2');
    assert.equal(scr.status, 'partial');
    assert.equal(scr.complete, 0);
    const siteRow = db.prepare('SELECT last_status FROM sites WHERE site_id = ?').get('poki');
    assert.equal(siteRow.last_status, 'partial');
  });
});

test('测试6 truncated 拒绝写入：正式历史不变', () => {
  withTempDb((db) => {
    const site = insertSite(db);
    createCrawlRun(db, { runId: 'run-1', startedAt: 't1' });
    persistCompleteSiteResult(db, { runId: 'run-1', site, result: completeResult([A, B, C]) });
    const before = counts(db);

    const truncated = completeResult([A, B, C, D], {
      status: 'partial',
      complete: false,
      truncated: true,
      truncationReasons: ['MAX_PAGE_URLS'],
    });
    assert.equal(isAdmissible(truncated), false);

    createCrawlRun(db, { runId: 'run-2', startedAt: 't2' });
    recordRejectedSiteResult(db, { runId: 'run-2', site, result: truncated });

    assert.deepEqual(counts(db), before);
    const scr = db.prepare('SELECT truncated FROM site_crawl_runs WHERE run_id = ?').get('run-2');
    assert.equal(scr.truncated, 1);
  });
});

test('测试7 写入中途失败：seen_urls 写完、added_urls 前抛错 → 整个事务回滚', () => {
  withTempDb((db) => {
    const site = insertSite(db);
    // 先 baseline，让第二次会走 added 分支
    createCrawlRun(db, { runId: 'run-1', startedAt: 't1' });
    persistCompleteSiteResult(db, { runId: 'run-1', site, result: completeResult([A, B, C]) });
    const before = counts(db);

    createCrawlRun(db, { runId: 'run-2', startedAt: 't2' });
    assert.throws(() => {
      persistCompleteSiteResult(db, {
        runId: 'run-2',
        site,
        result: completeResult([A, B, C, D]),
        hooks: {
          afterSeenUrls: () => {
            throw new Error('注入的中途失败');
          },
        },
      });
    }, /注入的中途失败/);

    // 事务应整体回滚：D 不应留在 seen_urls，added_urls 不应有新行
    assert.deepEqual(counts(db), before, '中途失败必须整体回滚，不留半写入数据');
    const hasD = db.prepare('SELECT COUNT(*) AS n FROM seen_urls WHERE normalized_url = ?').get(D).n;
    assert.equal(hasD, 0);
  });
});

test('测试8 多 Sitemap URL 去重：同一站点同一 URL 出现多次，seen_urls 只存一条', () => {
  withTempDb((db) => {
    const site = insertSite(db);
    createCrawlRun(db, { runId: 'run-1', startedAt: 't1' });
    // pageUrls 里 A 出现两次（含带 fragment 的变体，标准化后同一个）
    const r = persistCompleteSiteResult(db, {
      runId: 'run-1',
      site,
      result: completeResult([A, `${A}#frag`, B]),
    });
    assert.equal(r.pageUrlCount, 2, '标准化去重后只有 2 个唯一 URL');
    assert.equal(counts(db).seen, 2);
    const aRows = db.prepare('SELECT COUNT(*) AS n FROM seen_urls WHERE url_hash = (SELECT url_hash FROM seen_urls WHERE normalized_url = ?)').get(A).n;
    assert.equal(aRows, 1, 'URL-A 只应保存一条');
  });
});

test('测试9 同 URL 不同站点：各自保存，不跨站去重', () => {
  withTempDb((db) => {
    const site1 = insertSite(db, 'site1', 'site1.com');
    const site2 = insertSite(db, 'site2', 'site2.com');
    createCrawlRun(db, { runId: 'run-1', startedAt: 't1' });

    persistCompleteSiteResult(db, { runId: 'run-1', site: site1, result: completeResult([A]) });
    persistCompleteSiteResult(db, { runId: 'run-1', site: site2, result: completeResult([A]) });

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n, 2, '两个站点各存一条 URL-A');
    assert.equal(counts(db, 'site1').seen, 1);
    assert.equal(counts(db, 'site2').seen, 1);
  });
});

test('准入规则：空 pageUrls（pageUrlCount=0）也被拒绝', () => {
  const empty = completeResult([], { pageUrlCount: 0 });
  assert.equal(isAdmissible(empty), false);
  const good = completeResult([A]);
  assert.equal(isAdmissible(good), true);
});
