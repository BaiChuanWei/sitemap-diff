import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { loadLocalConfig } from '../../src/config.js';
import { createDashboardServer, SERVICE_NAME } from '../../src/dashboard/server.js';

const SITES_HEADER = 'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes,site_category';

function withDashboard(fn, { port = 0, seed } = {}) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-server-'));
    const config = loadLocalConfig({
      dbPath: join(dir, 'test.db'),
      sitesCsvPath: join(dir, 'sites.csv'),
      siteLimitsCsvPath: join(dir, 'site-limits.csv'),
      siteSitemapsCsvPath: join(dir, 'site-sitemaps.csv'),
      outputDir: join(dir, 'output'),
    });
    writeFileSync(config.sitesCsvPath, `${SITES_HEADER}\n`, 'utf-8');
    let dashboard;
    try {
      // 端口 0 = 由操作系统分配空闲端口，避免测试间冲突；但本项目的 Host
      // 校验依赖固定端口号，所以这里改用一个较少被占用的高位端口固定测试。
      const actualPort = port || 28711 + Math.floor(Math.random() * 500);
      dashboard = createDashboardServer({ config, port: actualPort });
      if (seed) seed(dashboard.db);
      await dashboard.listen();
      await fn({ dashboard, port: actualPort, config });
    } finally {
      if (dashboard) await dashboard.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function apiUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

function apiHeaders(port) {
  return { host: `127.0.0.1:${port}` };
}

test('服务只绑定 127.0.0.1', withDashboard(async ({ dashboard }) => {
  const addr = dashboard.server.address();
  assert.equal(addr.address, '127.0.0.1');
}));

test('GET /api/health 返回服务标识', withDashboard(async ({ port }) => {
  const res = await fetch(apiUrl(port, '/api/health'), { headers: apiHeaders(port) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.service, SERVICE_NAME);
  assert.ok(body.data.sessionToken && body.data.sessionToken.length > 0);
}));

test('未知路由返回 404，不会让进程崩溃', withDashboard(async ({ port }) => {
  const res = await fetch(apiUrl(port, '/api/does-not-exist'), { headers: apiHeaders(port) });
  assert.equal(res.status, 404);
}));

test('Host header 不匹配时拒绝（DNS rebinding 防护）', withDashboard(async ({ port }) => {
  // fetch()/undici 不允许覆盖 Host 请求头（会被静默忽略，永远发真实连接的
  // host），无法用来模拟"伪造 Host"的攻击场景；改用 node:http 直接控制。
  const status = await new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/health', method: 'GET', headers: { host: 'evil.example.com' } },
      (res) => resolvePromise(res.statusCode),
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
}));

test('静态首页可以正常返回', withDashboard(async ({ port }) => {
  const res = await fetch(apiUrl(port, '/'), { headers: apiHeaders(port) });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Sitemap 监控面板/);
}));
