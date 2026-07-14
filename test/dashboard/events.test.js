import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from '../../src/config.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { EventHub } from '../../src/dashboard/routes/events.js';

const SITES_HEADER = 'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes,site_category';

function withDashboard(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-events-'));
    const config = loadLocalConfig({
      dbPath: join(dir, 'test.db'),
      sitesCsvPath: join(dir, 'sites.csv'),
      siteLimitsCsvPath: join(dir, 'site-limits.csv'),
      siteSitemapsCsvPath: join(dir, 'site-sitemaps.csv'),
      outputDir: join(dir, 'output'),
    });
    writeFileSync(config.sitesCsvPath, `${SITES_HEADER}\n`, 'utf-8');
    const port = 28711 + Math.floor(Math.random() * 500);
    const dashboard = createDashboardServer({ config, port });
    try {
      await dashboard.listen();
      await fn({ dashboard, port });
    } finally {
      await dashboard.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** 读取一个 SSE 响应流，直到收到目标事件名或超时。 */
async function readUntilEvent(response, eventName, timeoutMs = 3000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(`event: ${eventName}`)) return buffer;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`超时未收到事件: ${eventName}`);
}

test('GET /api/events 返回 text/event-stream', withDashboard(async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { host: `127.0.0.1:${port}` } });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  await res.body.cancel();
}));

test('建立连接后立刻收到 connected 事件', withDashboard(async ({ port }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { host: `127.0.0.1:${port}` } });
  const buffer = await readUntilEvent(res, 'connected');
  assert.match(buffer, /event: connected/);
}));

function makeFakeRes(received) {
  return {
    writeHead: () => {},
    write: (chunk) => {
      if (received) received.push(chunk);
      return true;
    },
    end: () => {},
  };
}
function makeFakeReq() {
  return { on: () => {} };
}

test('心跳事件会周期性广播给所有连接', async () => {
  const hub = new EventHub();
  const received = [];
  hub.handleRequest(makeFakeReq(), makeFakeRes(received));
  hub.broadcast('heartbeat', { at: 'now' });
  assert.ok(received.some((c) => c.includes('event: heartbeat')));
  hub.close();
});

test('达到最大并发连接数后拒绝新连接', () => {
  const hub = new EventHub();
  let accepted = 0;
  for (let i = 0; i < 25; i++) {
    const ok = hub.handleRequest(makeFakeReq(), makeFakeRes());
    if (ok) accepted++;
  }
  assert.equal(accepted, 20, '最大连接数应该被限制在 20');
  hub.close();
});
