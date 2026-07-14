import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/index.js';
import { persistCompleteSiteResult, recordRejectedSiteResult, createCrawlRun, isAdmissible } from '../../src/storage/index.js';

/**
 * Dashboard M4：URL 生命周期比较（missing / consecutive_missing / restored）。
 * 只测新增的高风险语义，不重复 test/storage/persistence.test.js 已经覆盖的
 * baseline / added / 幂等 / partial 拒绝 / 事务回滚等 M3 场景。
 */

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'm4-lifecycle-'));
  const dbPath = join(dir, 'local.db');
  const db = openDb(dbPath);
  try {
    return fn(db, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertSite(db, siteId = 'poki', domain = 'poki.com') {
  db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES (?, ?, 1)`).run(siteId, domain);
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
    startedAt: '2026-07-14T00:00:00.000Z',
    finishedAt: '2026-07-14T00:00:01.000Z',
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

function urlStatusRow(db, siteId, url) {
  return db
    .prepare(
      `SELECT us.* FROM url_status us
       JOIN seen_urls s ON s.site_id = us.site_id AND s.url_hash = us.url_hash
       WHERE us.site_id = ? AND s.normalized_url = ?`,
    )
    .get(siteId, url);
}

const A = 'https://poki.com/g/a';
const B = 'https://poki.com/g/b';
const C = 'https://poki.com/g/c';
const D = 'https://poki.com/g/d';

test('测试1 六轮 URL 生命周期：baseline → missing → consecutive_missing → added 与 missing 并存 → restored → 另一个 URL missing', () => {
  withTempDb((db) => {
    const site = insertSite(db);
    const rounds = [
      { urls: [A, B, C], expect: { added: 0, missing: 0, consecutive: 0, restored: 0 }, note: 'baseline' },
      { urls: [A, B], expect: { added: 0, missing: 1, consecutive: 0, restored: 0 }, note: 'C 首次缺失' },
      { urls: [A, B], expect: { added: 0, missing: 0, consecutive: 1, restored: 0 }, note: 'C 连续两轮缺失' },
      { urls: [A, B, D], expect: { added: 1, missing: 0, consecutive: 0, restored: 0 }, note: 'D 新增，C 第三轮仍缺失但不再重复产生事件' },
      { urls: [A, B, C, D], expect: { added: 0, missing: 0, consecutive: 0, restored: 1 }, note: 'C 恢复，且不得被算成新增' },
      { urls: [A, C, D], expect: { added: 0, missing: 1, consecutive: 0, restored: 0 }, note: 'B 缺失' },
    ];

    rounds.forEach((round, i) => {
      const runId = `run-${i + 1}`;
      createCrawlRun(db, { runId, startedAt: `2026-07-14T0${i}:00:00Z` });
      const r = persistCompleteSiteResult(db, { runId, site, result: completeResult(round.urls) });
      assert.equal(r.addedCount, round.expect.added, `第${i + 1}轮(${round.note}) added`);
      assert.equal(r.missingCount, round.expect.missing, `第${i + 1}轮(${round.note}) missing`);
      assert.equal(r.consecutiveMissingCount, round.expect.consecutive, `第${i + 1}轮(${round.note}) consecutive_missing`);
      assert.equal(r.restoredCount, round.expect.restored, `第${i + 1}轮(${round.note}) restored`);
      assert.equal(r.comparisonPerformed, true, `第${i + 1}轮(${round.note}) comparisonPerformed`);

      const scr = db.prepare('SELECT * FROM site_crawl_runs WHERE run_id = ?').get(runId);
      assert.equal(scr.missing_url_count, round.expect.missing);
      assert.equal(scr.consecutive_missing_count, round.expect.consecutive);
      assert.equal(scr.restored_url_count, round.expect.restored);
      assert.equal(scr.comparison_performed, 1);
    });

    // 恢复后的 C：is_present=1，missing_streak 清零。
    const cStatus = urlStatusRow(db, 'poki', C);
    assert.equal(cStatus.is_present, 1);
    assert.equal(cStatus.missing_streak, 0);

    // B 在第 6 轮才第一次缺失：streak=1。
    const bStatus = urlStatusRow(db, 'poki', B);
    assert.equal(bStatus.is_present, 0);
    assert.equal(bStatus.missing_streak, 1);

    // seen_urls 永远只增不减（A/B/C/D 四个 URL，从未被删除）。
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_urls WHERE site_id = ?').get('poki').n, 4);
    // added_urls 只有 D 这一条（C 恢复不算新增）。
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM added_urls WHERE site_id = ?').get('poki').n, 1);
    assert.equal(db.prepare('SELECT normalized_url FROM added_urls WHERE site_id = ?').get('poki').normalized_url, D);

    // url_changes 流水：missing(C,run2) + consecutive_missing(C,run3) + restored(C,run5) + missing(B,run6) = 4 条。
    const changeRows = db.prepare('SELECT run_id, change_type FROM url_changes WHERE site_id = ? ORDER BY id').all('poki');
    assert.deepEqual(
      changeRows.map((r) => `${r.run_id}:${r.change_type}`),
      ['run-2:missing', 'run-3:consecutive_missing', 'run-5:restored', 'run-6:missing'],
    );
  });
});

test('测试2 不可靠结果（partial/failed/truncated/complete=false/零URL）绝不参与生命周期比较', () => {
  const cases = [
    { name: 'partial', overrides: { status: 'partial', complete: false } },
    { name: 'failed', overrides: { status: 'failed', complete: false, pageUrls: [], pageUrlCount: 0 } },
    { name: 'truncated', overrides: { truncated: true, complete: false, truncationReasons: ['MAX_PAGE_URLS'] } },
    { name: 'complete=false', overrides: { complete: false } },
    { name: '零 URL', overrides: { pageUrls: [], pageUrlCount: 0 } },
  ];

  for (const c of cases) {
    withTempDb((db) => {
      const site = insertSite(db);
      // 先建立一轮可靠 baseline + 一轮 missing，制造非零的既有状态。
      createCrawlRun(db, { runId: 'base', startedAt: 't0' });
      persistCompleteSiteResult(db, { runId: 'base', site, result: completeResult([A, B, C]) });
      createCrawlRun(db, { runId: 'gap', startedAt: 't1' });
      persistCompleteSiteResult(db, { runId: 'gap', site, result: completeResult([A, B]) }); // C missing
      const before = {
        status: db.prepare('SELECT * FROM url_status WHERE site_id = ? ORDER BY url_hash').all('poki'),
        changes: db.prepare('SELECT COUNT(*) AS n FROM url_changes WHERE site_id = ?').get('poki').n,
      };

      const bad = completeResult([A, B, C, D], c.overrides);
      assert.equal(isAdmissible(bad), false, `${c.name} 不应可准入`);
      createCrawlRun(db, { runId: `bad-${c.name}`, startedAt: 't2' });
      recordRejectedSiteResult(db, { runId: `bad-${c.name}`, site, result: bad });

      const after = {
        status: db.prepare('SELECT * FROM url_status WHERE site_id = ? ORDER BY url_hash').all('poki'),
        changes: db.prepare('SELECT COUNT(*) AS n FROM url_changes WHERE site_id = ?').get('poki').n,
      };
      assert.deepEqual(after.status, before.status, `${c.name}：url_status 不得被改动`);
      assert.equal(after.changes, before.changes, `${c.name}：url_changes 不得新增行`);

      const scr = db.prepare('SELECT * FROM site_crawl_runs WHERE run_id = ?').get(`bad-${c.name}`);
      assert.equal(scr.comparison_performed, 0, `${c.name}：comparison_performed 必须是 0`);
      assert.equal(scr.missing_url_count, 0);
      assert.equal(scr.consecutive_missing_count, 0);
      assert.equal(scr.restored_url_count, 0);
    });
  }
});

test('测试3 单站事务失败：生命周期写完后、site_crawl_runs 前抛错 → url_status/url_changes 整体回滚', () => {
  withTempDb((db) => {
    const site = insertSite(db);
    createCrawlRun(db, { runId: 'run-1', startedAt: 't1' });
    persistCompleteSiteResult(db, { runId: 'run-1', site, result: completeResult([A, B, C]) });
    createCrawlRun(db, { runId: 'run-2', startedAt: 't2' });
    persistCompleteSiteResult(db, { runId: 'run-2', site, result: completeResult([A, B]) }); // C missing

    const before = {
      status: db.prepare('SELECT * FROM url_status WHERE site_id = ? ORDER BY url_hash').all('poki'),
      changes: db.prepare('SELECT * FROM url_changes WHERE site_id = ? ORDER BY id').all('poki'),
    };

    createCrawlRun(db, { runId: 'run-3', startedAt: 't3' });
    assert.throws(() => {
      persistCompleteSiteResult(db, {
        runId: 'run-3',
        site,
        result: completeResult([A, B, C]), // C 本应 restored
        hooks: {
          afterLifecycle: () => {
            throw new Error('注入的中途失败（生命周期写完之后）');
          },
        },
      });
    }, /注入的中途失败/);

    const after = {
      status: db.prepare('SELECT * FROM url_status WHERE site_id = ? ORDER BY url_hash').all('poki'),
      changes: db.prepare('SELECT * FROM url_changes WHERE site_id = ? ORDER BY id').all('poki'),
    };
    assert.deepEqual(after.status, before.status, 'url_status 必须整体回滚，不留半写入的 restored 状态');
    assert.deepEqual(after.changes, before.changes, 'url_changes 必须整体回滚，不留半写入的 restored 事件');
    // site_crawl_runs 这次运行也不应该有任何记录（在 hook 之后才会写）。
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_crawl_runs WHERE run_id = ?').get('run-3').n, 0);
  });
});

test('测试4 跨站隔离 + 重复相同数据幂等：两站独立计数，稳定重复的数据不产生 phantom missing/restored', () => {
  withTempDb((db) => {
    const siteA = insertSite(db, 'siteA', 'sitea.com');
    const siteB = insertSite(db, 'siteB', 'siteb.com');
    const urlsA = ['https://sitea.com/g/1', 'https://sitea.com/g/2'];
    const urlsB = ['https://siteb.com/g/1', 'https://siteb.com/g/2'];

    createCrawlRun(db, { runId: 'r1', startedAt: 't1' });
    persistCompleteSiteResult(db, { runId: 'r1', site: siteA, result: { ...completeResult(urlsA), siteId: 'siteA' } });
    persistCompleteSiteResult(db, { runId: 'r1', site: siteB, result: { ...completeResult(urlsB), siteId: 'siteB' } });

    // siteA 的第二个 URL 消失，siteB 保持不变——两站互不影响。
    createCrawlRun(db, { runId: 'r2', startedAt: 't2' });
    const rA2 = persistCompleteSiteResult(db, { runId: 'r2', site: siteA, result: { ...completeResult([urlsA[0]]), siteId: 'siteA' } });
    const rB2 = persistCompleteSiteResult(db, { runId: 'r2', site: siteB, result: { ...completeResult(urlsB), siteId: 'siteB' } });
    assert.equal(rA2.missingCount, 1, 'siteA 应该检测到 1 个缺失');
    assert.equal(rB2.missingCount, 0, 'siteB 不应该受 siteA 影响');
    assert.equal(rB2.restoredCount, 0);

    // 连续 3 轮重复提交完全相同的数据（siteB 保持不变，siteA 保持"仍然缺失"）：
    // 不应该产生任何 phantom 事件，只有一次 consecutive_missing（streak 1→2），之后不再重复。
    for (let i = 3; i <= 5; i++) {
      const runId = `r${i}`;
      createCrawlRun(db, { runId, startedAt: `t${i}` });
      const rA = persistCompleteSiteResult(db, { runId, site: siteA, result: { ...completeResult([urlsA[0]]), siteId: 'siteA' } });
      const rB = persistCompleteSiteResult(db, { runId, site: siteB, result: { ...completeResult(urlsB), siteId: 'siteB' } });
      assert.equal(rB.missingCount, 0, `第${i}轮 siteB 不应有 missing`);
      assert.equal(rB.restoredCount, 0, `第${i}轮 siteB 不应有 restored`);
      assert.equal(rA.restoredCount, 0, `第${i}轮 siteA 不应有 restored（一直缺失，不是恢复）`);
      if (i === 3) {
        assert.equal(rA.consecutiveMissingCount, 1, '第3轮 streak 1→2，应该产生一次 consecutive_missing');
      } else {
        assert.equal(rA.consecutiveMissingCount, 0, `第${i}轮 streak 已经 ≥2，不应重复产生事件`);
      }
    }

    // siteB 从头到尾没有任何变化事件；siteA 只有 1 条 missing + 1 条 consecutive_missing。
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM url_changes WHERE site_id = ?').get('siteB').n, 0);
    const aChanges = db.prepare('SELECT change_type FROM url_changes WHERE site_id = ? ORDER BY id').all('siteA');
    assert.deepEqual(aChanges.map((r) => r.change_type), ['missing', 'consecutive_missing']);
  });
});
