import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverSitemaps } from '../../src/sitemap/discovery.js';
import { DEFAULT_LIMITS } from '../../src/sitemap/limits.js';
import { startTestServer, createRouter } from '../helpers/http-server.js';

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

test('robots.txt 不存在（404）不会导致崩溃，会退回常见路径探测', async () => {
  const { url, close } = await startTestServer(createRouter({}));
  try {
    const result = await discoverSitemaps({ baseUrl: url, limits: fastLimits() });
    assert.equal(result.sitemaps.length, 3, '应该探测 3 个常见路径');
    assert.ok(result.sitemaps.every((s) => s.source === 'common-path'));
    assert.ok(result.warnings.some((w) => /robots\.txt 不可用/.test(w)));
  } finally {
    await close();
  }
});

test('常见路径探测最多只尝试 3 个固定路径', async () => {
  const { url, close } = await startTestServer(createRouter({}));
  try {
    const result = await discoverSitemaps({ baseUrl: url, limits: fastLimits() });
    const paths = result.sitemaps.map((s) => new URL(s.url).pathname).sort();
    assert.deepEqual(paths, ['/sitemap-index.xml', '/sitemap.xml', '/sitemap_index.xml'].sort());
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
