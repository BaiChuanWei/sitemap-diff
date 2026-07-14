import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from '../../src/config.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { _resetDiagnosisRegistryForTests } from '../../src/dashboard/routes/diagnose-write.js';

const SITES_HEADER = 'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes,site_category';

function withDashboard(fn) {
  return async () => {
    _resetDiagnosisRegistryForTests();
    const dir = mkdtempSync(join(tmpdir(), 'api-sites-write-'));
    const config = loadLocalConfig({
      dbPath: join(dir, 'test.db'),
      sitesCsvPath: join(dir, 'sites.csv'),
      siteLimitsCsvPath: join(dir, 'site-limits.csv'),
      siteSitemapsCsvPath: join(dir, 'site-sitemaps.csv'),
      outputDir: join(dir, 'output'),
    });
    writeFileSync(config.sitesCsvPath, `${SITES_HEADER}\npoki,poki.com,high,true,,,,,\n`, 'utf-8');
    const port = 28711 + Math.floor(Math.random() * 500);
    // 诊断走 fetchImpl 注入，绝不发起真实网络请求（自动测试硬性要求）：
    // 立刻返回 404，让 diagnoseSite() 快速走完"没有发现 Sitemap"的路径。
    const diagnoseFetchImpl = async () => new Response('not found', { status: 404 });
    const dashboard = createDashboardServer({ config, port, logDir: join(dir, 'logs'), diagnoseFetchImpl });
    try {
      await dashboard.listen();
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

async function getConfigVersion(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sites/poki`, { headers: { host: `127.0.0.1:${port}` } });
  return (await res.json()).data.configVersion;
}

// ---- 启动时同步 ----

test('启动同步：sites.csv 里已有的站点无需任何写操作即可在 GET /api/sites 中看到', withDashboard(async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, { headers: { host: `127.0.0.1:${port}` } });
  const { sites } = (await res.json()).data;
  assert.equal(sites.length, 1);
  assert.equal(sites[0].site_id, 'poki');
}));

// ---- CSRF / Origin ----

test('POST /api/sites：缺少 CSRF token 时拒绝（403）', withDashboard(async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ site_id: 'x', domain: 'x.com' }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_CSRF_TOKEN');
}));

test('POST /api/sites：错误的 CSRF token 时拒绝（403）', withDashboard(async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-dashboard-token': 'wrong-token' },
    body: JSON.stringify({ site_id: 'x', domain: 'x.com' }),
  });
  assert.equal(res.status, 403);
}));

test('对抗场景：服务重启后旧 CSRF token 失效——换一个新实例的 token 会被拒绝', withDashboard(async ({ port, config, dir }) => {
  // token 是"每次服务启动生成一次"，用另一个 dashboard 实例（模拟"面板服务
  // 重启后，浏览器页面还没刷新、带着重启前的旧 token 发请求"）的 token 去
  // 打第一个实例，必须被拒绝，不能因为"look like a valid random token"就放行。
  const otherPort = 28711 + Math.floor(Math.random() * 500) + 1500;
  const otherDashboard = createDashboardServer({ config, port: otherPort, logDir: join(dir, 'logs') });
  try {
    await otherDashboard.listen();
    const staleToken = otherDashboard.sessionToken;
    const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
      method: 'POST',
      headers: jsonHeaders(port, staleToken),
      body: JSON.stringify({ site_id: 'x', domain: 'x.com' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_CSRF_TOKEN');
  } finally {
    await otherDashboard.close();
  }
}));

test('POST /api/sites：非同源 Origin 时拒绝（403）', withDashboard(async ({ port, token }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', origin: 'http://evil.example.com', 'x-dashboard-token': token },
    body: JSON.stringify({ site_id: 'x', domain: 'x.com' }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, 'FORBIDDEN_ORIGIN');
}));

test('POST /api/sites：错误的 Content-Type 时拒绝（415）', withDashboard(async ({ port, token }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain', origin: `http://127.0.0.1:${port}`, 'x-dashboard-token': token },
    body: 'not json',
  });
  assert.equal(res.status, 415);
}));

test('POST /api/sites：非法 JSON 时拒绝（400）', withDashboard(async ({ port, token }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: '{not valid json',
  });
  assert.equal(res.status, 400);
}));

test('POST /api/sites：请求体过大时拒绝（413）', withDashboard(async ({ port, token }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'x', domain: 'x.com', notes: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert.equal(res.status, 413);
}));

test('对抗场景：客户端在响应返回前中止请求，服务进程不崩溃，后续请求仍正常', withDashboard(async ({ port, token }) => {
  const controller = new AbortController();
  const abortedRequest = fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'y', domain: 'y.com' }),
    signal: controller.signal,
  }).catch(() => {}); // 期望被 abort，忽略 AbortError
  controller.abort();
  await abortedRequest;

  // 服务必须还活着，且能正常处理下一个请求。
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(res.status, 200);
}));

// ---- 新增站点 ----

test('POST /api/sites：新增合法站点，返回 201，syncSites 成功', withDashboard(async ({ port, token, config }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'newsite', domain: 'newsite.com', expectedConfigVersion: version }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.data.site.site_id, 'newsite');

  const csvText = readFileSync(config.sitesCsvPath, 'utf-8');
  assert.match(csvText, /newsite,newsite\.com/);
}));

test('POST /api/sites：重复 site_id 返回 422', withDashboard(async ({ port, token }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'poki', domain: 'poki2.com', expectedConfigVersion: version }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.error.fieldErrors.site_id);
}));

test('POST /api/sites：SSRF 防护——sitemap_url 指向 127.0.0.1 时拒绝', withDashboard(async ({ port, token }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'evil', domain: 'evil.com', sitemap_url: 'http://127.0.0.1:9999/internal', expectedConfigVersion: version }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.error.fieldErrors.sitemap_url);
}));

test('POST /api/sites：未知字段拒绝（422）', withDashboard(async ({ port, token }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'x', domain: 'x.com', unexpected_field: 1, expectedConfigVersion: version }),
  });
  assert.equal(res.status, 422);
}));

test('POST /api/sites：配置版本冲突返回 409', withDashboard(async ({ port, token }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'x', domain: 'x.com', expectedConfigVersion: 'stale-version-value' }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, 'CONFIG_VERSION_CONFLICT');
}));

// ---- 编辑 / 暂停 ----

test('PATCH /api/sites/:id：编辑字段成功', withDashboard(async ({ port, token }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites/poki`, {
    method: 'PATCH',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ notes: '更新过的备注', expectedConfigVersion: version }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.site.notes, '更新过的备注');
}));

test('PATCH /api/sites/:id：不存在的站点返回 404', withDashboard(async ({ port, token }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites/no-such-site`, {
    method: 'PATCH',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ notes: 'x', expectedConfigVersion: version }),
  });
  assert.equal(res.status, 404);
}));

test('PATCH /api/sites/:id：尝试修改 site_id 返回 422', withDashboard(async ({ port, token }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites/poki`, {
    method: 'PATCH',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'renamed', expectedConfigVersion: version }),
  });
  assert.equal(res.status, 422);
}));

test('POST /api/sites/:id/disable：暂停站点不删除历史；POST .../enable 恢复', withDashboard(async ({ port, token, config }) => {
  let version = await getConfigVersion(port);
  const disableRes = await fetch(`http://127.0.0.1:${port}/api/sites/poki/disable`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ expectedConfigVersion: version }),
  });
  assert.equal(disableRes.status, 200);
  const csvAfterDisable = readFileSync(config.sitesCsvPath, 'utf-8');
  assert.match(csvAfterDisable, /poki,poki\.com,high,false/);

  version = await getConfigVersion(port);
  const enableRes = await fetch(`http://127.0.0.1:${port}/api/sites/poki/enable`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ expectedConfigVersion: version }),
  });
  assert.equal(enableRes.status, 200);
  const csvAfterEnable = readFileSync(config.sitesCsvPath, 'utf-8');
  assert.match(csvAfterEnable, /poki,poki\.com,high,true/);
}));

// ---- 限制 ----

test('PUT /api/sites/:id/limits：合法限制保存成功', withDashboard(async ({ port, token, config }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites/poki/limits`, {
    method: 'PUT',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ max_download_bytes: 62914560, expectedConfigVersion: version }),
  });
  assert.equal(res.status, 200);
  const csv = readFileSync(config.siteLimitsCsvPath, 'utf-8');
  assert.match(csv, /poki,62914560/);
}));

test('PUT /api/sites/:id/limits：超硬上限返回 422', withDashboard(async ({ port, token }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites/poki/limits`, {
    method: 'PUT',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ max_page_urls: 2000000, expectedConfigVersion: version }),
  });
  assert.equal(res.status, 422);
}));

// ---- 手工 Sitemap ----

test('PUT /api/sites/:id/sitemaps：manual_only 且没有启用 Endpoint 时返回 422', withDashboard(async ({ port, token }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites/poki/sitemaps`, {
    method: 'PUT',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ mode: 'manual_only', urls: [], expectedConfigVersion: version }),
  });
  assert.equal(res.status, 422);
}));

test('PUT /api/sites/:id/sitemaps：多 Endpoint 保存成功', withDashboard(async ({ port, token, config }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites/poki/sitemaps`, {
    method: 'PUT',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({
      mode: 'manual_only',
      urls: [
        { sitemap_url: 'https://poki.com/a.xml', enabled: true },
        { sitemap_url: 'https://poki.com/b.xml', enabled: true },
      ],
      expectedConfigVersion: version,
    }),
  });
  assert.equal(res.status, 200);
  const csv = readFileSync(config.siteSitemapsCsvPath, 'utf-8');
  assert.match(csv, /poki,https:\/\/poki\.com\/a\.xml/);
  assert.match(csv, /poki,https:\/\/poki\.com\/b\.xml/);
}));

test('PUT /api/sites/:id/sitemaps：非法 Sitemap URL 返回 422', withDashboard(async ({ port, token }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites/poki/sitemaps`, {
    method: 'PUT',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ mode: 'merge', urls: [{ sitemap_url: 'not-a-url', enabled: true }], expectedConfigVersion: version }),
  });
  assert.equal(res.status, 422);
}));

// ---- 诊断 ----

test('POST /api/sites/:id/diagnose：只读，不写数据库；结果可通过 diagnostic_id 轮询', withDashboard(async ({ port, token, config }) => {
  const before = {
    seen: (await import('../../src/db/index.js')).openDb(config.dbPath),
  };
  const seenBefore = before.seen.prepare('SELECT COUNT(*) n FROM seen_urls').get().n;
  before.seen.close();

  const res = await fetch(`http://127.0.0.1:${port}/api/sites/poki/diagnose`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 202);
  const { diagnosticId } = (await res.json()).data;
  assert.ok(diagnosticId);

  // 轮询直到诊断结束（本地无网络场景下 diagnoseSite 会因为域名不可达很快失败/返回，不需要真实等待太久）。
  let final;
  for (let i = 0; i < 50; i++) {
    const pollRes = await fetch(`http://127.0.0.1:${port}/api/diagnostics/${diagnosticId}`, { headers: { host: `127.0.0.1:${port}` } });
    const body = (await pollRes.json()).data;
    if (body.status !== 'running') {
      final = body;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(final, '诊断应该在合理时间内结束');
  assert.ok(final.status === 'done' || final.status === 'failed');

  const { openDb } = await import('../../src/db/index.js');
  const dbAfter = openDb(config.dbPath);
  const seenAfter = dbAfter.prepare('SELECT COUNT(*) n FROM seen_urls').get().n;
  dbAfter.close();
  assert.equal(seenAfter, seenBefore, '诊断不应该写 seen_urls');
}));

test('POST /api/sites/:id/diagnose：同站重复诊断被抑制（409）', withDashboard(async ({ port, token, config, dir }) => {
  // 用一个会挂起足够久的 fetchImpl 保证"诊断进行中"这个窗口在第二次请求
  // 到达时依然打开——上面共享的默认 fetchImpl 立刻 resolve，两次请求之间
  // 诊断可能已经跑完，测不出"重复诊断被抑制"这个场景，所以这里单独起
  // 一个带人工延迟的 dashboard 实例。
  const slowFetchImpl = () => new Promise((resolve) => setTimeout(() => resolve(new Response('not found', { status: 404 })), 300));
  const slowPort = 28711 + Math.floor(Math.random() * 500) + 1000;
  const slowDashboard = createDashboardServer({ config, port: slowPort, logDir: join(dir, 'logs'), diagnoseFetchImpl: slowFetchImpl });
  try {
    await slowDashboard.listen();
    const slowToken = slowDashboard.sessionToken;
    const first = await fetch(`http://127.0.0.1:${slowPort}/api/sites/poki/diagnose`, { method: 'POST', headers: jsonHeaders(slowPort, slowToken), body: '{}' });
    assert.equal(first.status, 202);
    const second = await fetch(`http://127.0.0.1:${slowPort}/api/sites/poki/diagnose`, { method: 'POST', headers: jsonHeaders(slowPort, slowToken), body: '{}' });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.equal(body.error.code, 'DIAGNOSIS_IN_PROGRESS');
  } finally {
    await slowDashboard.close();
  }
}));

test('GET /api/diagnostics/:id：找不到的诊断 id 返回 404', withDashboard(async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/no-such-id`, { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(res.status, 404);
}));

// ---- 审计日志 ----

test('审计日志：成功和失败的写操作都记录到 logs/config-audit.jsonl，不含 token', withDashboard(async ({ port, token, dir }) => {
  const version = await getConfigVersion(port);
  await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'audited', domain: 'audited.com', expectedConfigVersion: version }),
  });
  const logPath = join(dir, 'logs', 'config-audit.jsonl');
  const content = readFileSync(logPath, 'utf-8');
  const lines = content.trim().split('\n').map((l) => JSON.parse(l));
  const entry = lines.find((l) => l.site_id === 'audited');
  assert.ok(entry);
  assert.equal(entry.action, 'create_site');
  assert.equal(entry.result, 'success');
  assert.doesNotMatch(content, new RegExp(token));
}));

// ---- XSS ----

test('新增站点的 notes 含 <script> 时原样存储（渲染安全由前端 textContent 负责，服务端不做净化破坏原始数据）', withDashboard(async ({ port, token, config }) => {
  const version = await getConfigVersion(port);
  const res = await fetch(`http://127.0.0.1:${port}/api/sites`, {
    method: 'POST',
    headers: jsonHeaders(port, token),
    body: JSON.stringify({ site_id: 'xsstest', domain: 'xsstest.com', notes: '<script>alert(1)</script>', expectedConfigVersion: version }),
  });
  assert.equal(res.status, 201);
  const detail = await fetch(`http://127.0.0.1:${port}/api/sites/xsstest`, { headers: { host: `127.0.0.1:${port}` } });
  const body = (await detail.json()).data;
  assert.equal(body.config.notes, '<script>alert(1)</script>');
}));
