import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSitemaps } from '../../src/sitemap/discovery.js';
import { DEFAULT_LIMITS } from '../../src/sitemap/limits.js';
import { startTestServer, createRouter, urlsetXml } from '../helpers/http-server.js';

function fastLimits(overrides = {}) {
  return { ...DEFAULT_LIMITS, REQUEST_TIMEOUT_MS: 300, MAX_RETRIES: 0, RETRY_BASE_DELAY_MS: 1, ...overrides };
}

test('robots.txt：解析 Sitemap: 声明，大小写不敏感，去除空格，去重', async () => {
  const { url, close } = await startTestServer(
    createRouter({
      '/robots.txt': () => ({
        headers: { 'content-type': 'text/plain' },
        body: [
          'User-agent: *',
          'Disallow: /admin',
          'Sitemap:   https://example-games.test/sitemap-games.xml   ',
          'sitemap: https://example-games.test/sitemap-news.xml',
          'Sitemap: https://example-games.test/sitemap-games.xml',
        ].join('\n'),
      }),
    }),
  );
  try {
    const result = await discoverSitemaps({ baseUrl: url, limits: fastLimits() });
    const urls = result.sitemaps.map((s) => s.url);
    assert.deepEqual(urls, [
      'https://example-games.test/sitemap-games.xml',
      'https://example-games.test/sitemap-news.xml',
    ]);
    assert.ok(result.sitemaps.every((s) => s.source === 'robots'));
  } finally {
    await close();
  }
});

test('手工配置的 sitemap_url 始终保留，即使 robots.txt 也声明了别的', async () => {
  const { url, close } = await startTestServer(
    createRouter({
      '/robots.txt': () => ({ body: 'Sitemap: https://example-games.test/from-robots.xml' }),
    }),
  );
  try {
    const result = await discoverSitemaps({
      baseUrl: url,
      manualSitemapUrl: 'https://example-games.test/manual.xml',
      limits: fastLimits(),
    });
    const urls = result.sitemaps.map((s) => s.url);
    assert.ok(urls.includes('https://example-games.test/manual.xml'));
    assert.ok(urls.includes('https://example-games.test/from-robots.xml'));
    const manual = result.sitemaps.find((s) => s.url === 'https://example-games.test/manual.xml');
    assert.equal(manual.source, 'manual');
  } finally {
    await close();
  }
});

test('robots.txt 不存在（404）不会导致崩溃；常见路径也都不存在时不硬塞候选，返回空发现列表', async () => {
  // Milestone 5 阶段3 用真实站点验证时发现：discovery 曾经无条件把 3 个常见
  // 路径全部当"已发现"塞给 recursive-loader，若猜的路径不存在（404），会被
  // recursive-loader 记成"失败 Endpoint"，把本来完全正常的站点拖成 partial
  // （真实案例：coolmathgames.com 只有 /sitemap.xml 真实存在，另外两个猜测
  // 路径 404，整站被错误地降级为 partial）。现在常见路径候选必须先验证
  // "真实存在且是合法 Sitemap" 才会被采纳，猜错的候选直接静默跳过，不再
  // 冒充"发现结果"传递给下游、也不会被当成失败 Endpoint。
  const { url, close } = await startTestServer(createRouter({}));
  try {
    const result = await discoverSitemaps({ baseUrl: url, limits: fastLimits() });
    assert.equal(result.sitemaps.length, 0, '常见路径全都不存在时不应该硬塞 3 个必定失败的候选');
    assert.ok(result.warnings.some((w) => /robots\.txt 不可用/.test(w)));
  } finally {
    await close();
  }
});

test('常见路径探测：只有真实存在且是合法 Sitemap 的候选会被采纳，最多尝试 3 个固定路径', async () => {
  const { url, close } = await startTestServer(
    createRouter({
      // 只有 /sitemap.xml 真实存在，/sitemap_index.xml 和 /sitemap-index.xml 都是 404
      // （对应 coolmathgames.com 的真实情况）。
      '/sitemap.xml': () => ({ body: urlsetXml([`${url}/g/a`]) }),
    }),
  );
  try {
    const result = await discoverSitemaps({ baseUrl: url, limits: fastLimits() });
    assert.equal(result.sitemaps.length, 1, '只应该采纳真正存在且合法的那一个候选');
    assert.equal(new URL(result.sitemaps[0].url).pathname, '/sitemap.xml');
    assert.equal(result.sitemaps[0].source, 'common-path');
  } finally {
    await close();
  }
});

test('常见路径探测：候选返回 200 但内容不是合法 Sitemap（空文件/非 XML）时会被跳过', async () => {
  // 对应 brainrot-games.io / amzgame.com 的真实情况：/sitemap_index.xml 和
  // /sitemap-index.xml 都返回 HTTP 200 但 Content-Length:0（真空文件），
  // 不能只看 HTTP 状态码就认为"发现成功"。
  const { url, close } = await startTestServer(
    createRouter({
      '/sitemap.xml': () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '' }),
    }),
  );
  try {
    const result = await discoverSitemaps({ baseUrl: url, limits: fastLimits() });
    assert.equal(result.sitemaps.length, 0, '200 但不是合法 XML 的候选不应该被当作发现结果');
  } finally {
    await close();
  }
});

test('robots.txt 有结果时不会再做常见路径探测', async () => {
  const { url, close } = await startTestServer(
    createRouter({
      '/robots.txt': () => ({ body: 'Sitemap: https://example-games.test/only-one.xml' }),
    }),
  );
  try {
    const result = await discoverSitemaps({ baseUrl: url, limits: fastLimits() });
    assert.equal(result.sitemaps.length, 1);
    assert.equal(result.sitemaps[0].source, 'robots');
  } finally {
    await close();
  }
});
