import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeExisting } from '../../bin/dashboard.js';
import { loadLocalConfig } from '../../src/config.js';
import { createAndListenDashboard } from './helpers/listen-with-retry.js';
import { createServer } from 'node:http';

const SITES_HEADER = 'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes,site_category';

// 和 helpers/listen-with-retry.js 用同一段高位区间，避免和历史遗留的
// 28711(+offset) 范围混用导致端口号被复用（fetch 连接池缓存陈旧连接）。
function randomHighPort() {
  return 40000 + Math.floor(Math.random() * 10000);
}

/** 原始 http.Server 版本的"监听时端口冲突就换一个重试"，供不经过 dashboard server 的测试使用。 */
async function listenOnFreePort(server, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = randomHighPort();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`连续 ${maxAttempts} 次都没能找到空闲端口`);
}

test('probeExisting：空闲端口返回 free', async () => {
  const port = randomHighPort();
  const result = await probeExisting(port);
  assert.equal(result.status, 'free');
});

test('probeExisting：本项目服务已在运行时返回 self + pid（用于"直接打开现有面板"）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-cli-'));
  const config = loadLocalConfig({
    dbPath: join(dir, 'test.db'),
    sitesCsvPath: join(dir, 'sites.csv'),
    siteLimitsCsvPath: join(dir, 'site-limits.csv'),
    siteSitemapsCsvPath: join(dir, 'site-sitemaps.csv'),
    outputDir: join(dir, 'output'),
  });
  writeFileSync(config.sitesCsvPath, `${SITES_HEADER}\n`, 'utf-8');
  const { dashboard, port } = await createAndListenDashboard({ config });
  try {
    const result = await probeExisting(port);
    assert.equal(result.status, 'self');
    assert.equal(result.pid, process.pid);
  } finally {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeExisting：端口被非本项目服务占用时返回 other（不得静默换端口）', async () => {
  const otherServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'some-other-app' }));
  });
  const port = await listenOnFreePort(otherServer);
  try {
    const result = await probeExisting(port);
    assert.equal(result.status, 'other');
  } finally {
    await new Promise((r) => otherServer.close(r));
  }
});
