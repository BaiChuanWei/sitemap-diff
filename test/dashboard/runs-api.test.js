import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from '../../src/config.js';
import { createAndListenDashboard } from './helpers/listen-with-retry.js';

const SITES_HEADER = 'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes,site_category';

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
    durationMs: 5,
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

function withDashboard(fn, { collectSiteFn, classifyFetchPagesFn } = {}) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-api-'));
    const config = loadLocalConfig({
      dbPath: join(dir, 'test.db'),
      sitesCsvPath: join(dir, 'sites.csv'),
      siteLimitsCsvPath: join(dir, 'site-limits.csv'),
      siteSitemapsCsvPath: join(dir, 'site-sitemaps.csv'),
      outputDir: join(dir, 'output'),
      lockPath: join(dir, 'collector.lock'), // 绝不能用默认路径，会撞到真实项目的 data/collector.lock
    });
    writeFileSync(
      config.sitesCsvPath,
      `${SITES_HEADER}\npoki,poki.com,high,true,,,,,\ncrazygames,crazygames.com,high,true,,,,,\nnewgrounds,newgrounds.com,high,false,,,,,\n`,
      'utf-8',
    );
    const { dashboard, port } = await createAndListenDashboard({
      config,
      logDir: join(dir, 'logs'),
      collectSiteFn: collectSiteFn || (async (p) => completeResult(p.siteId, [`https://${p.siteId}.com/g/a`])),
      classifyFetchPagesFn: classifyFetchPagesFn || (async () => new Map()),
    });
    try {
      const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { host: `127.0.0.1:${port}` } });
      const health = (await healthRes.json()).data;
      await fn({ port, config, dir, token: health.sessionToken });
    } finally {
      await dashboard.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function jsonHeaders(port, token) {
  return {
    host: `127.0.0.1:${port}`,
    'content-type': 'application/json',
    origin: `http://127.0.0.1:${port}`,
    'x-dashboard-token': token,
  };
}

async function postJson(port, token, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify(body || {}),
  });
}

async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}` } });
  return { status: res.status, body: await res.json() };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor 超时');
}

// ---- 安全防护复用 ----

test('POST /api/runs：缺少 CSRF token 拒绝（403）', withDashboard(async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'all' }),
  });
  assert.equal(res.status, 403);
}));

test('POST /api/runs/:id/cancel：非同源 Origin 拒绝（403）', withDashboard(async ({ port, token }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/runs/whatever/cancel`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', origin: 'http://evil.example.com', 'x-dashboard-token': token },
    body: '{}',
  });
  assert.equal(res.status, 403);
}));

// ---- 启动/查询/取消：完整流程 ----

test('POST /api/runs {mode:all}：202 启动，GET /api/runs/active 能看到进行中状态，完成后清空', withDashboard(async ({ port, token }) => {
  const startRes = await postJson(port, token, '/api/runs', { mode: 'all' });
  assert.equal(startRes.status, 202);
  const started = (await startRes.json()).data;
  assert.ok(started.runId);
  assert.equal(started.siteCount, 2); // newgrounds 已暂停，不计入

  const activeDuring = await getJson(port, '/api/runs/active');
  assert.equal(activeDuring.status, 200);
  // 可能已经跑完（collectSiteFn 很快），所以只断言字段结构而不是必然非 null。
  if (activeDuring.body.data.active) {
    assert.equal(activeDuring.body.data.active.runId, started.runId);
    assert.ok(['preparing', 'collecting', 'classifying', 'reporting'].includes(activeDuring.body.data.active.phase));
  }

  await waitFor(async () => (await getJson(port, '/api/runs/active')).body.data.active === null);

  const detail = await getJson(port, `/api/runs/${started.runId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.run.status, 'success');
}));

{
  // 默认 fixture 的 collectSiteFn 立刻 resolve，两个站点的采集可能在两次
  // POST 之间的网络往返时间内就跑完——用一个卡住不放的 collectSiteFn，
  // 确保发第二个请求时第一个运行确定还处于活动状态。
  const collectSiteFn = () => new Promise(() => {}); // 永远不 resolve，测试结束时随 dashboard.close() 一起回收
  test('POST /api/runs：已有活动运行时第二次请求返回 409 RUN_ALREADY_ACTIVE 并带 activeRunId', withDashboard(async ({ port, token }) => {
    const first = await postJson(port, token, '/api/runs', { mode: 'all' });
    const firstBody = await first.json();
    const second = await postJson(port, token, '/api/runs', { mode: 'all' });
    assert.equal(second.status, 409);
    const secondBody = await second.json();
    assert.equal(secondBody.error.code, 'RUN_ALREADY_ACTIVE');
    assert.equal(secondBody.error.activeRunId, firstBody.data.runId);
  }, { collectSiteFn }));
}

test('POST /api/runs {mode:selected, siteIds:[]}：422 INVALID_SITE_SELECTION', withDashboard(async ({ port, token }) => {
  const res = await postJson(port, token, '/api/runs', { mode: 'selected', siteIds: [] });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_SITE_SELECTION');
}));

test('POST /api/runs：siteIds 里塞 SQL 注入形状的字符串，安全拒绝（422），不触发任何异常', withDashboard(async ({ port, token }) => {
  const res = await postJson(port, token, '/api/runs', { mode: 'selected', siteIds: ["poki'; DROP TABLE sites; --"] });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_SITE_SELECTION');

  // 确认 sites 表真的没被动过（哪怕只是走了参数化查询也确认一下"表还在"）。
  const health = await fetch(`http://127.0.0.1:${port}/api/sites`, { headers: { host: `127.0.0.1:${port}` } });
  const sites = (await health.json()).data.sites;
  assert.equal(sites.length, 3);
}));

test('POST /api/runs：选中已暂停站点返回 422 SITE_DISABLED', withDashboard(async ({ port, token }) => {
  const res = await postJson(port, token, '/api/runs', { mode: 'selected', siteIds: ['newgrounds'] });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, 'SITE_DISABLED');
}));

test('POST /api/runs：选中不存在的站点返回 404 SITE_NOT_FOUND', withDashboard(async ({ port, token }) => {
  const res = await postJson(port, token, '/api/runs', { mode: 'selected', siteIds: ['no-such-site'] });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'SITE_NOT_FOUND');
}));

test('GET /api/runs/active：没有活动运行时返回 { active: null }', withDashboard(async ({ port }) => {
  const res = await getJson(port, '/api/runs/active');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.active, null);
}));

test('POST /api/runs/:id/cancel：取消不存在的 run_id 返回 404', withDashboard(async ({ port, token }) => {
  const res = await postJson(port, token, '/api/runs/no-such-run/cancel', {});
  assert.equal(res.status, 404);
}));

// ---- 逐站表格 / 分页新增 URL / 报告下载 ----

{
  // 站点按 site_id 字母序调度："crazygames" 排在 "poki" 前面——必须让
  // crazygames 立刻完成、poki 卡在 gate 里，才能在 poki 仍是第二个待处理
  // 站点时观察到它处于"运行中"状态；反过来则会在第一站就卡死，永远轮不到
  // 第二站开始。
  let releasePoki;
  const gate = new Promise((resolve) => { releasePoki = resolve; });
  const collectSiteFn = async (p) => {
    if (p.siteId === 'crazygames') return completeResult('crazygames', ['https://crazygames.com/g/a']);
    await gate;
    return completeResult('poki', ['https://poki.com/g/a']);
  };

  test('GET /api/runs/:id/sites：运行中能看到 waiting/running，SSE 能收到 site_started/site_finished', withDashboard(async ({ port, token }) => {
    const eventsRes = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { host: `127.0.0.1:${port}` } });
    const reader = eventsRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function readUntil(name, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      // 先检查已经缓冲下来的内容——上一次调用可能"多读"到了这次要找的事件
      // （一次 reader.read() 拿到的字节块里可能同时含有好几个事件），不这样
      // 检查的话就得傻等下一次真正有新字节到达（最多 15 秒后的心跳）才会
      // 发现其实早就有了，白白拖慢测试。
      if (buffer.includes(`event: ${name}`)) return true;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(`event: ${name}`)) return true;
      }
      throw new Error(`超时未收到事件: ${name}`);
    }

    const startRes = await postJson(port, token, '/api/runs', { mode: 'all' });
    const { runId } = (await startRes.json()).data;

    await readUntil('run_started');
    await readUntil('site_started'); // crazygames 开始
    await readUntil('site_finished'); // crazygames 完成，poki 紧接着开始（卡在 gate 里）

    const sitesDuring = await getJson(port, `/api/runs/${runId}/sites`);
    const pokiDuring = sitesDuring.body.data.sites.find((s) => s.siteId === 'poki');
    assert.equal(pokiDuring.status, 'running');

    releasePoki();
    await readUntil('run_finished');
    await reader.cancel().catch(() => {});
  }, { collectSiteFn }));
}

test('GET /api/runs/:id/changes：分页返回新增 URL，未分类时显示"待分类"', withDashboard(async ({ port, token }) => {
  const startRes = await postJson(port, token, '/api/runs', { mode: 'selected', siteIds: ['poki'] });
  const { runId } = (await startRes.json()).data;
  await waitFor(async () => (await getJson(port, '/api/runs/active')).body.data.active === null);

  const changes = await getJson(port, `/api/runs/${runId}/changes?site_id=poki&page=1&page_size=50`);
  assert.equal(changes.status, 200);
  // 首次 baseline 运行 added 恒为 0，这里只验证分页结构本身没有报错。
  assert.equal(changes.body.data.page, 1);
  assert.equal(changes.body.data.pageSize, 50);
  assert.equal(changes.body.data.total, 0);
  assert.deepEqual(changes.body.data.items, []);
}));

test('GET /api/runs/:id/changes：非法 page 参数拒绝（422）', withDashboard(async ({ port, token }) => {
  const startRes = await postJson(port, token, '/api/runs', { mode: 'all' });
  const { runId } = (await startRes.json()).data;
  await waitFor(async () => (await getJson(port, '/api/runs/active')).body.data.active === null);

  const res = await getJson(port, `/api/runs/${runId}/changes?page=not-a-number`);
  assert.equal(res.status, 422);
}));

{
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  const collectSiteFn = async (p) => {
    if (p.siteId === 'poki') { await gate; }
    return completeResult(p.siteId, [`https://${p.siteId}.com/g/a`]);
  };

  test('GET /api/runs/:id/report：仍在采集阶段时返回 409 REPORT_NOT_READY；完成后可下载报告文件', withDashboard(async ({ port, token }) => {
    const startRes = await postJson(port, token, '/api/runs', { mode: 'selected', siteIds: ['poki'] });
    const { runId } = (await startRes.json()).data;

    const early = await getJson(port, `/api/runs/${runId}/report`);
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'REPORT_NOT_READY');

    releaseGate();
    await waitFor(async () => (await getJson(port, '/api/runs/active')).body.data.active === null);

    const reportMeta = await getJson(port, `/api/runs/${runId}/report`);
    assert.equal(reportMeta.status, 200);
    assert.ok(reportMeta.body.data.files.newUrlsCsv);
    assert.equal(reportMeta.body.data.files.newUrlsCsv, 'new-urls.csv');

    const fileRes = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/report/new-urls.csv`, { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(fileRes.status, 200);
    assert.match(fileRes.headers.get('content-type'), /text\/csv/);
    const text = await fileRes.text();
    assert.match(text, /detected_at,run_id,site_id/);

    // 路径穿越/非白名单文件名一律拒绝。
    const traversal = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/report/${encodeURIComponent('../../../etc/passwd')}`, {
      headers: { host: `127.0.0.1:${port}` },
    });
    assert.equal(traversal.status, 404);

    const unknownFile = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/report/not-a-real-file.csv`, { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(unknownFile.status, 404);
  }, { collectSiteFn }));
}

{
  // 安全停止的运行跳过分类/报告阶段——运行结束、内存态清空之后，报告接口
  // 必须仍然拒绝（而不是用 generateReport() 现算出一份"看起来正常、实际
  // 什么都没分类"的空报告，误导用户以为整轮流程正常跑完了）。
  //
  // 需要第三个启用站点才能真正验证"取消后不再调度新站点"：只有 2 个站点
  // 时，第二站早已经在 gate 里卡住（取消请求发生在这个窗口），没有第三个
  // 待调度的站点可供"跳过"，整轮会正常跑完变成 success 而不是 cancelled。
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  const collectSiteFn = async (p) => {
    if (p.siteId === 'crazygames') return completeResult('crazygames', ['https://crazygames.com/g/a']);
    await gate;
    return completeResult(p.siteId, [`https://${p.siteId}.com/g/a`]);
  };

  test('GET /api/runs/:id/report：被安全停止的运行结束后仍返回 409 REPORT_NOT_READY，不生成空报告', withDashboard(async ({ port, token }) => {
    const addSiteRes = await postJson(port, token, '/api/sites', { site_id: 'zeta', domain: 'zeta.example' });
    assert.equal(addSiteRes.status, 201);

    const startRes = await postJson(port, token, '/api/runs', { mode: 'all' });
    const { runId } = (await startRes.json()).data;

    await waitFor(async () => {
      const { body } = await getJson(port, '/api/runs/active');
      return body.data.active && body.data.active.stats.sitesCompleted >= 1;
    });
    const cancelRes = await postJson(port, token, `/api/runs/${runId}/cancel`, {});
    assert.equal(cancelRes.status, 200);
    releaseGate();

    await waitFor(async () => (await getJson(port, '/api/runs/active')).body.data.active === null);

    const detail = await getJson(port, `/api/runs/${runId}`);
    assert.equal(detail.body.data.run.status, 'cancelled');

    const reportRes = await getJson(port, `/api/runs/${runId}/report`);
    assert.equal(reportRes.status, 409);
    assert.equal(reportRes.body.error.code, 'REPORT_NOT_READY');

    const fileRes = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/report/new-urls.csv`, { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(fileRes.status, 409);
  }, { collectSiteFn }));
}
