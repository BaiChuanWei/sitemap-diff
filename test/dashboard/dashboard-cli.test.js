import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeExisting, computeIsMainModule } from '../../bin/dashboard.js';
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

test('computeIsMainModule：Windows 风格反斜杠路径也能正确匹配（旧的手工拼接方式会误判为 false）', () => {
  // 这个沙盒本身是 Linux，真实的 node:url pathToFileURL 在 Linux 上不会按
  // Windows 规则转换反斜杠路径（反斜杠只是普通文件名字符，不是分隔符），
  // 没办法在这里让"真实" pathToFileURL 产出 Windows 上才会有的结果。这里
  // 用一个忠实模拟 Windows 转换规则（反斜杠 -> 正斜杠，保留盘符）的假实现
  // 注入进去，只验证 computeIsMainModule 的比较逻辑本身是对的；
  // pathToFileURL 在真实 Windows 上转换是否正确是 Node.js 自身的职责，
  // 已经在真实 Windows 环境人工验证通过（触发本次修复的 bug 报告）。
  const fakeWindowsPathToFileURL = (p) => new URL('file:///' + p.replace(/\\/g, '/'));
  const argv1 = 'D:\\sitemap监控\\bin\\dashboard.js';
  // import.meta.url 在真实 Node 里同样是 pathToFileURL() 的产物（由 Node
  // 自己在加载模块时算出来），非 ASCII 字符会被 URL 规范化成百分号编码
  // ——metaUrl 必须用同一个转换函数算出来，而不是手写一个不带编码的字面
  // 量字符串，否则这里比较的根本不是"同一个东西该不该相等"这件事。
  const metaUrl = fakeWindowsPathToFileURL(argv1).href;

  assert.equal(computeIsMainModule(argv1, metaUrl, fakeWindowsPathToFileURL), true);

  // 回归防护：证明这确实是 pathToFileURL 修复的场景，不是凑巧測出来的——
  // 旧的 `file://${argv1}` 手工拼接对同样的输入必须判断失败。
  assert.equal(`file://${argv1}` === metaUrl, false);

  // 没有 argv1（比如被当作普通模块 import，而不是作为入口脚本执行）时，
  // 不应该判断为主模块，这条边界在改动后也不能被破坏。
  assert.equal(computeIsMainModule(undefined, metaUrl, fakeWindowsPathToFileURL), false);
});

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
