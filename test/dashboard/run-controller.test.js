import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/index.js';
import { loadLocalConfig } from '../../src/config.js';
import { acquireLock, releaseLock } from '../../src/lock.js';
import { createRunController } from '../../src/dashboard/run-controller.js';
import { ApiError } from '../../src/dashboard/routes/sites-write.js';

function fakeEventHub() {
  const events = [];
  return {
    events,
    broadcast(name, payload) {
      events.push({ name, payload });
    },
  };
}

function completeResult(siteId, pageUrls) {
  return {
    siteId,
    domain: `${siteId}.com`,
    status: 'success',
    complete: true,
    truncated: false,
    truncationReasons: [],
    startedAt: '2026-07-14T00:00:00.000Z',
    finishedAt: '2026-07-14T00:00:01.000Z',
    durationMs: 10,
    discoveredSitemaps: [`https://${siteId}.com/sitemap.xml`],
    processedSitemaps: [{ url: `https://${siteId}.com/sitemap.xml`, status: 'success', type: 'urlset' }],
    failedSitemaps: [],
    pageUrls,
    pageUrlCount: pageUrls.length,
    sitemapCount: 1,
    warnings: [],
    errors: [],
  };
}

function noPagesFetch() {
  return async () => new Map(); // 分类阶段不抓真实页面
}

function withController(fn, { collectSiteFn, classifyFetchPagesFn } = {}) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-controller-'));
    const config = loadLocalConfig({
      dbPath: join(dir, 'test.db'),
      sitesCsvPath: join(dir, 'sites.csv'),
      siteLimitsCsvPath: join(dir, 'site-limits.csv'),
      siteSitemapsCsvPath: join(dir, 'site-sitemaps.csv'),
      outputDir: join(dir, 'output'),
      lockPath: join(dir, 'collector.lock'),
    });
    const db = openDb(config.dbPath);
    db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('s1','s1.com',1)`).run();
    db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('s2','s2.com',1)`).run();
    db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('s3','s3.com',0)`).run(); // 暂停站点
    const eventHub = fakeEventHub();
    const controller = createRunController({
      db,
      config,
      eventHub,
      collectSiteFn: collectSiteFn || (async (p) => completeResult(p.siteId, [`https://${p.siteId}.com/g/a`])),
      classifyFetchPagesFn: classifyFetchPagesFn || noPagesFetch(),
      logDir: join(dir, 'logs'),
    });
    try {
      await fn({ db, config, controller, eventHub, dir });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * 构造一对 {collectSiteFn, releaseS2}：s1 立刻成功，s2 卡在 pending 直到
 * 测试主动调用 releaseS2()——用于在"s2 仍在运行中"这个窗口内断言实时状态。
 */
function makeGatedFixture() {
  let releaseS2;
  const gate = new Promise((resolve) => { releaseS2 = resolve; });
  const collectSiteFn = async (p) => {
    if (p.siteId === 's1') return completeResult('s1', ['https://s1.com/g/a']);
    await gate;
    return completeResult('s2', ['https://s2.com/g/a']);
  };
  return { collectSiteFn, releaseS2: () => releaseS2() };
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor 超时');
}

test('startRun mode=all：跑全部启用站点，阶段依次推进到 completed', withController(async ({ controller, db, eventHub }) => {
  const started = controller.startRun({ mode: 'all' });
  assert.equal(started.siteCount, 2); // s3 已暂停，不计入
  await waitFor(() => controller.getActiveSnapshot() === null);

  const row = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(started.runId);
  assert.equal(row.status, 'success');
  assert.equal(row.sites_total, 2);
  assert.equal(row.run_mode, 'all');
  assert.equal(row.site_selection, null);

  const names = eventHub.events.map((e) => e.name);
  assert.ok(names.includes('run_started'));
  assert.ok(names.includes('classification_started'));
  assert.ok(names.includes('classification_finished'));
  assert.ok(names.includes('report_generated'));
  assert.ok(names.includes('run_finished'));
  assert.equal(names[names.length - 1], 'run_finished', 'run_finished 必须是最后一个事件');
}));

test('startRun mode=selected：只跑选中的站点，crawl_runs 记录选中范围', withController(async ({ controller, db }) => {
  const started = controller.startRun({ mode: 'selected', siteIds: ['s1'] });
  assert.equal(started.siteCount, 1);
  await waitFor(() => controller.getActiveSnapshot() === null);

  const row = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(started.runId);
  assert.equal(row.run_mode, 'selected');
  assert.deepEqual(JSON.parse(row.site_selection), ['s1']);
  assert.equal(row.sites_total, 1);

  const s2Row = db.prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? AND site_id = ?').get(started.runId, 's2');
  assert.equal(s2Row, undefined, 's2 不在选中范围内，不应该有运行记录');
}));

test('startRun：空选择拒绝（422 INVALID_SITE_SELECTION）', withController(async ({ controller }) => {
  assert.throws(() => controller.startRun({ mode: 'selected', siteIds: [] }), (err) => err instanceof ApiError && err.code === 'INVALID_SITE_SELECTION' && err.status === 422);
}));

test('startRun：未知 site_id 拒绝（404 SITE_NOT_FOUND）', withController(async ({ controller }) => {
  assert.throws(() => controller.startRun({ mode: 'selected', siteIds: ['no-such-site'] }), (err) => err instanceof ApiError && err.code === 'SITE_NOT_FOUND' && err.status === 404);
}));

test('startRun：已暂停站点拒绝（422 SITE_DISABLED）', withController(async ({ controller }) => {
  assert.throws(() => controller.startRun({ mode: 'selected', siteIds: ['s3'] }), (err) => err instanceof ApiError && err.code === 'SITE_DISABLED' && err.status === 422);
}));

test('startRun：已有活动运行时第二次启动返回 409 RUN_ALREADY_ACTIVE 且带 activeRunId', withController(async ({ controller }) => {
  const first = controller.startRun({ mode: 'all' });
  assert.throws(
    () => controller.startRun({ mode: 'all' }),
    (err) => err instanceof ApiError && err.code === 'RUN_ALREADY_ACTIVE' && err.status === 409 && err.extra.activeRunId === first.runId,
  );
  await waitFor(() => controller.getActiveSnapshot() === null);
}));

test('startRun：collector.lock 被外部（模拟 CLI）持有时拒绝（503 COLLECTOR_LOCKED）', withController(async ({ controller, config }) => {
  const lock = acquireLock(config.lockPath, { runId: 'cli-run', startedAt: new Date().toISOString() });
  assert.equal(lock.acquired, true);
  try {
    assert.throws(() => controller.startRun({ mode: 'all' }), (err) => err instanceof ApiError && err.code === 'COLLECTOR_LOCKED' && err.status === 503);
  } finally {
    releaseLock(config.lockPath, 'cli-run');
  }
}));

test('单站失败不影响其他站：一个抛错，其它正常完成', withController(
  async ({ controller, db }) => {
    const started = controller.startRun({ mode: 'all' });
    await waitFor(() => controller.getActiveSnapshot() === null);
    const row = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(started.runId);
    assert.equal(row.sites_success, 1);
    assert.equal(row.sites_failed, 1);
    assert.equal(row.status, 'partial');
  },
  { collectSiteFn: async (p) => (p.siteId === 's1' ? completeResult('s1', ['https://s1.com/g/a']) : Promise.reject(new Error('模拟网络错误'))) },
));

{
  const { collectSiteFn, releaseS2 } = makeGatedFixture();
  test('实时快照：站点仍在运行时 status=running，完成后变成 success/failed', withController(
    async ({ controller }) => {
      const started = controller.startRun({ mode: 'all' });
      // s1 立刻成功；s2 要等 gate 打开才返回，给测试一个窗口读取"运行中"状态。
      await waitFor(() => {
        const snap = controller.getActiveSnapshot();
        return snap && snap.stats.sitesCompleted >= 1;
      });
      const sitesDuring = controller.getRunSites(started.runId);
      const s2During = sitesDuring.find((s) => s.siteId === 's2');
      assert.equal(s2During.status, 'running', 's2 应该正处于运行中状态');

      releaseS2();
      await waitFor(() => controller.getActiveSnapshot() === null);
    },
    { collectSiteFn },
  ));
}

{
  const { collectSiteFn, releaseS2 } = makeGatedFixture();
  test('安全停止：请求取消后不再调度新站点，当前站点正常完成', withController(
    async ({ controller, db }) => {
      // 需要第三个启用站点才能真正验证"取消后不再调度新站点"：s1 立刻完成，
      // s2 卡在 gate 里（取消请求就发生在这个窗口），s4 必须完全没被调度过。
      db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('s4','s4.com',1)`).run();

      const started = controller.startRun({ mode: 'all' });
      await waitFor(() => {
        const snap = controller.getActiveSnapshot();
        return snap && snap.stats.sitesCompleted >= 1;
      });
      const cancelResult = controller.cancelRun(started.runId);
      assert.equal(cancelResult.cancelRequested, true);
      releaseS2();

      await waitFor(() => controller.getActiveSnapshot() === null);
      const row = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(started.runId);
      assert.equal(row.status, 'cancelled');
      assert.equal(row.sites_success, 2); // s1 和 s2 都已经开始，允许安全完成
      const s4Row = db.prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? AND site_id = ?').get(started.runId, 's4');
      assert.equal(s4Row, undefined, 's4 从未被调度，不应该有任何运行记录');
    },
    { collectSiteFn },
  ));
}

test('重复取消幂等：连续两次 cancelRun 不报错，只广播一次 run_cancel_requested', withController(async ({ controller, eventHub }) => {
  const started = controller.startRun({ mode: 'all' });
  controller.cancelRun(started.runId);
  controller.cancelRun(started.runId);
  await waitFor(() => controller.getActiveSnapshot() === null);
  const cancelRequestedCount = eventHub.events.filter((e) => e.name === 'run_cancel_requested').length;
  assert.equal(cancelRequestedCount, 1);
}));

test('取消不存在的 run_id 返回 404 RUN_NOT_FOUND', withController(async ({ controller }) => {
  assert.throws(() => controller.cancelRun('no-such-run'), (err) => err instanceof ApiError && err.code === 'RUN_NOT_FOUND' && err.status === 404);
}));

test('取消已经结束的运行返回 409 RUN_ALREADY_FINISHED', withController(async ({ controller }) => {
  const started = controller.startRun({ mode: 'all' });
  await waitFor(() => controller.getActiveSnapshot() === null);
  assert.throws(() => controller.cancelRun(started.runId), (err) => err instanceof ApiError && err.code === 'RUN_ALREADY_FINISHED' && err.status === 409);
}));

test('分类阶段抛错：crawl_runs 状态被修正为 failed，不停留在采集阶段的 success', withController(
  async ({ controller, db }) => {
    // classifyRun 只在本轮真的产生了 added_urls 时才会调用 fetchPagesFn——
    // 首次 baseline 运行 added 恒为 0，不会触发抓取，也就测不出"分类抓取
    // 失败"这个场景。这里先手工把 s1/s2 标记为"已经建立过 baseline"，
    // 这样 collectSiteFn 返回的 URL 相对于 seen_urls 就是真正的新增。
    const past = '2026-01-01T00:00:00.000Z';
    for (const siteId of ['s1', 's2']) {
      db.prepare(`UPDATE sites SET baseline_completed_at = ? WHERE site_id = ?`).run(past, siteId);
      db.prepare(
        `INSERT INTO seen_urls (site_id, original_url, normalized_url, url_hash, first_seen_at, last_seen_at, first_run_id, last_run_id)
         VALUES (?, ?, ?, ?, ?, ?, 'seed-run', 'seed-run')`,
      ).run(siteId, `https://${siteId}.com/old`, `https://${siteId}.com/old`, `hash-${siteId}-old`, past, past);
    }

    const started = controller.startRun({ mode: 'all' });
    await waitFor(() => controller.getActiveSnapshot() === null);
    const row = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(started.runId);
    assert.equal(row.status, 'failed');
    // 采集阶段的正式历史已经落盘，不因为分类失败而回滚。
    const addedCount = db.prepare('SELECT COUNT(*) n FROM added_urls WHERE run_id = ?').get(started.runId).n;
    assert.ok(addedCount > 0, '本轮应该有真正的新增 URL（否则测不出分类失败场景）');
  },
  { classifyFetchPagesFn: async () => { throw new Error('模拟分类抓取失败'); } },
));

test('isRunKnown：活动运行和历史运行都能识别，未知 run_id 返回 false', withController(async ({ controller }) => {
  const started = controller.startRun({ mode: 'all' });
  assert.equal(controller.isRunKnown(started.runId), true);
  await waitFor(() => controller.getActiveSnapshot() === null);
  assert.equal(controller.isRunKnown(started.runId), true);
  assert.equal(controller.isRunKnown('no-such-run'), false);
}));

{
  let round = 0;
  const collectSiteFn = async (p) => {
    round++;
    // 第一轮只有 /a（会成为 baseline）；第二轮多了一个真正新增的 /b。
    const urls = round === 1 ? [`https://${p.siteId}.com/a`] : [`https://${p.siteId}.com/a`, `https://${p.siteId}.com/b`];
    return completeResult(p.siteId, urls);
  };

  test('两轮运行：第一轮全部 baseline（added=0），第二轮正确发现新增 URL', withController(async ({ controller, db }) => {
    const first = controller.startRun({ mode: 'selected', siteIds: ['s1'] });
    await waitFor(() => controller.getActiveSnapshot() === null);
    const firstRow = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(first.runId);
    assert.equal(firstRow.added_url_count, 0, '首次 baseline 运行 added 恒为 0');
    assert.ok(db.prepare('SELECT baseline_completed_at FROM sites WHERE site_id = ?').get('s1').baseline_completed_at);

    const second = controller.startRun({ mode: 'selected', siteIds: ['s1'] });
    await waitFor(() => controller.getActiveSnapshot() === null);
    const secondRow = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(second.runId);
    assert.equal(secondRow.added_url_count, 1, '第二轮应该只把 /b 记为新增，/a 在第一轮已经见过');

    const added = db.prepare('SELECT original_url FROM added_urls WHERE site_id = ?').all('s1');
    assert.equal(added.length, 1);
    assert.equal(added[0].original_url, 'https://s1.com/b');
  }, { collectSiteFn }));
}
