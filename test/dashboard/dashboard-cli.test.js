import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeExisting } from '../../bin/dashboard.js';
import { loadLocalConfig } from '../../src/config.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { createServer } from 'node:http';

test('probeExisting：空闲端口返回 free', async () => {
  const port = 28711 + Math.floor(Math.random() * 500);
  const result = await probeExisting(port);
  assert.equal(result.status, 'free');
});

test('probeExisting：本项目服务已在运行时返回 self + pid（用于"直接打开现有面板"）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-cli-'));
  const config = loadLocalConfig({ dbPath: join(dir, 'test.db'), outputDir: join(dir, 'output') });
  const port = 28711 + Math.floor(Math.random() * 500);
  const dashboard = createDashboardServer({ config, port });
  try {
    await dashboard.listen();
    const result = await probeExisting(port);
    assert.equal(result.status, 'self');
    assert.equal(result.pid, process.pid);
  } finally {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeExisting：端口被非本项目服务占用时返回 other（不得静默换端口）', async () => {
  const port = 28711 + Math.floor(Math.random() * 500);
  const otherServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'some-other-app' }));
  });
  await new Promise((r) => otherServer.listen(port, '127.0.0.1', r));
  try {
    const result = await probeExisting(port);
    assert.equal(result.status, 'other');
  } finally {
    await new Promise((r) => otherServer.close(r));
  }
});
