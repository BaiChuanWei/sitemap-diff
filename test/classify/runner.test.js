import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/index.js';
import { persistCompleteSiteResult, createCrawlRun } from '../../src/storage/index.js';
import { classifyRun } from '../../src/classify/runner.js';
import { extractPageMeta } from '../../src/classify/page-meta.js';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'm4-runner-'));
  const db = openDb(join(dir, 'local.db'));
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function completeResult(siteId, pageUrls) {
  return {
    siteId,
    domain: `${siteId}.com`,
    status: 'success',
    complete: true,
    truncated: false,
    truncationReasons: [],
    startedAt: 't0',
    finishedAt: 't1',
    durationMs: 1,
    discoveredSitemaps: [],
    processedSitemaps: [{ url: `https://${siteId}.com/sitemap.xml`, status: 'success' }],
    failedSitemaps: [],
    pageUrls,
    pageUrlCount: pageUrls.length,
    sitemapCount: 1,
    warnings: [],
    errors: [],
  };
}

/** 建立 baseline，再在第二个 run 里加入 addedUrls，返回该 run 的 runId。 */
function seedAddedUrls(db, siteId, expectedGamePath, baselineUrls, addedUrls) {
  db.prepare('INSERT INTO sites (site_id, domain, enabled, expected_game_path) VALUES (?, ?, 1, ?)').run(
    siteId, `${siteId}.com`, expectedGamePath ?? null,
  );
  const site = { site_id: siteId, domain: `${siteId}.com` };
  createCrawlRun(db, { runId: 'baseline', startedAt: 't0' });
  persistCompleteSiteResult(db, { runId: 'baseline', site, result: completeResult(siteId, baselineUrls) });
  createCrawlRun(db, { runId: 'run-2', startedAt: 't1' });
  persistCompleteSiteResult(db, { runId: 'run-2', site, result: completeResult(siteId, [...baselineUrls, ...addedUrls]) });
  return 'run-2';
}

test('每条 added_url 都产出一条分类（URL 绝不丢弃），三类可区分', async () => {
  await withTempDb(async (db) => {
    const runId = seedAddedUrls(db, 'poki', '/g/', ['https://poki.com/g/base'], [
      'https://poki.com/g/new-hero',    // game
      'https://poki.com/category/action', // non_game（不抓取）
      'https://poki.com/foo/bar/baz',   // unknown
    ]);

    // 注入抓取：为 game URL 返回带标题的页面，交叉确认 → high
    const fetchPagesFn = async (urls) => {
      const m = new Map();
      for (const u of urls) {
        if (u.includes('new-hero')) m.set(u, { ok: true, meta: extractPageMeta('<title>New Hero</title><h1>New Hero</h1>') });
        else m.set(u, { ok: true, meta: extractPageMeta('<title>Unrelated</title>') });
      }
      return m;
    };

    const r = await classifyRun(db, { runId, fetchPagesFn });
    assert.equal(r.total, 3);
    assert.equal(r.counts.game, 1);
    assert.equal(r.counts.non_game, 1);
    assert.equal(r.counts.unknown, 1);

    const stored = db.prepare('SELECT COUNT(*) AS n FROM url_classifications WHERE run_id = ?').get(runId).n;
    assert.equal(stored, 3, '分类数必须等于 added_urls 数');

    const game = db.prepare("SELECT * FROM url_classifications WHERE page_type='game'").get();
    assert.equal(game.confidence, 'high');
    assert.equal(game.game_name, 'new-hero');
  });
});

test('非游戏 URL 不触发抓取（fetchUrls 不含 non_game）', async () => {
  await withTempDb(async (db) => {
    const runId = seedAddedUrls(db, 's', null, ['https://s.com/g/base'], [
      'https://s.com/style.css',
      'https://s.com/g/real-game',
    ]);
    let fetched = [];
    const fetchPagesFn = async (urls) => {
      fetched = urls;
      const m = new Map();
      for (const u of urls) m.set(u, { ok: true, meta: extractPageMeta('<title>x</title>') });
      return m;
    };
    await classifyRun(db, { runId, fetchPagesFn });
    assert.ok(!fetched.some((u) => u.endsWith('.css')), '静态资源不应被抓取');
    assert.ok(fetched.some((u) => u.includes('real-game')));
  });
});

test('测试5(流程内) 页面抓取失败 → unknown/low + classification_error，URL 仍保留', async () => {
  await withTempDb(async (db) => {
    const runId = seedAddedUrls(db, 'poki', '/g/', ['https://poki.com/g/base'], ['https://poki.com/g/will-fail']);
    const fetchPagesFn = async (urls) => {
      const m = new Map();
      for (const u of urls) m.set(u, { ok: false, errorCode: 'TIMEOUT' });
      return m;
    };
    const r = await classifyRun(db, { runId, fetchPagesFn });
    assert.equal(r.counts.unknown, 1);
    assert.equal(r.classificationErrors, 1);
    const row = db.prepare('SELECT * FROM url_classifications WHERE run_id = ?').get(runId);
    assert.equal(row.page_type, 'unknown');
    assert.equal(row.confidence, 'low');
    assert.equal(row.classification_error, 'TIMEOUT');
    assert.equal(row.original_url, 'https://poki.com/g/will-fail', '失败也要保留 URL');
    assert.equal(row.game_name, 'will-fail');
  });
});

test('测试10 重复分类幂等：同一 run 再次分类不新增行、结果一致', async () => {
  await withTempDb(async (db) => {
    const runId = seedAddedUrls(db, 'poki', '/g/', ['https://poki.com/g/base'], [
      'https://poki.com/g/a',
      'https://poki.com/g/b',
    ]);
    const fetchPagesFn = async (urls) => new Map(urls.map((u) => [u, { ok: true, meta: extractPageMeta('<title>x</title>') }]));

    await classifyRun(db, { runId, fetchPagesFn });
    const after1 = db.prepare('SELECT COUNT(*) AS n FROM url_classifications WHERE run_id = ?').get(runId).n;
    await classifyRun(db, { runId, fetchPagesFn });
    const after2 = db.prepare('SELECT COUNT(*) AS n FROM url_classifications WHERE run_id = ?').get(runId).n;
    assert.equal(after1, 2);
    assert.equal(after2, 2, '重复分类不应新增行');
  });
});

test('空 run（无新增）分类返回 0，不报错', async () => {
  await withTempDb(async (db) => {
    createCrawlRun(db, { runId: 'empty', startedAt: 't' });
    const r = await classifyRun(db, { runId: 'empty' });
    assert.equal(r.total, 0);
    assert.deepEqual(r.counts, { game: 0, non_game: 0, unknown: 0 });
  });
});

test('分类只读 added_urls/seen_urls，不改动它们', async () => {
  await withTempDb(async (db) => {
    const runId = seedAddedUrls(db, 's', '/g/', ['https://s.com/g/base'], ['https://s.com/g/a']);
    const seenBefore = db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n;
    const addedBefore = db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n;
    const fetchPagesFn = async (urls) => new Map(urls.map((u) => [u, { ok: true, meta: extractPageMeta('<title>x</title>') }]));
    await classifyRun(db, { runId, fetchPagesFn });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n, seenBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n, addedBefore);
  });
});
