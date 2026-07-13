import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSite } from '../../src/sitemap/collector.js';
import { DEFAULT_LIMITS } from '../../src/sitemap/limits.js';
import { startTestServer, createRouter, urlsetXml, indexXml } from '../helpers/http-server.js';

function fastLimits(overrides = {}) {
  return { ...DEFAULT_LIMITS, REQUEST_TIMEOUT_MS: 300, MAX_RETRIES: 0, RETRY_BASE_DELAY_MS: 1, ...overrides };
}

test('端到端：robots.txt 发现 Sitemap Index，递归拿到页面 URL，返回完整结构化结果', async () => {
  const base = { url: undefined };
  const { url, close } = await startTestServer(
    createRouter({
      '/robots.txt': () => ({ body: `Sitemap: ${base.url}/index.xml` }),
      '/index.xml': () => ({ body: indexXml([`${base.url}/child.xml`]) }),
      '/child.xml': () => ({ body: urlsetXml([`${base.url}/g/found-it`]) }),
    }),
  );
  base.url = url;
  try {
    const result = await collectSite({ siteId: 'site-a', domain: 'site-a.test', baseUrl: url, limits: fastLimits() });
    assert.equal(result.siteId, 'site-a');
    assert.equal(result.status, 'success');
    assert.deepEqual(result.discoveredSitemaps, [`${url}/index.xml`]);
    assert.deepEqual(result.pageUrls, [`${url}/g/found-it`]);
    assert.equal(result.sitemapCount, 2);
    assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0);
    assert.ok(result.startedAt && result.finishedAt);
  } finally {
    await close();
  }
});

test('手工 Sitemap URL：不需要 baseUrl 也能采集', async () => {
  const { url, close } = await startTestServer(
    createRouter({
      '/manual.xml': () => ({ body: urlsetXml(['https://example-games.test/g/manual-game']) }),
    }),
  );
  try {
    const result = await collectSite({ manualSitemapUrl: `${url}/manual.xml`, limits: fastLimits() });
    assert.equal(result.status, 'success');
    assert.deepEqual(result.pageUrls, ['https://example-games.test/g/manual-game']);
  } finally {
    await close();
  }
});

test('没有发现任何 Sitemap 入口：状态为 failed，不会抛异常', async () => {
  const { url, close } = await startTestServer(createRouter({}));
  try {
    const result = await collectSite({ baseUrl: url, limits: fastLimits({ COMMON_SITEMAP_PATHS: [] }) });
    assert.equal(result.status, 'failed');
    assert.equal(result.pageUrlCount, 0);
    assert.ok(result.errors.some((e) => e.code === 'NO_SITEMAP_DISCOVERED'));
  } finally {
    await close();
  }
});
