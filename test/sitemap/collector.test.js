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
    assert.equal(result.complete, true, '完整成功的采集结果 complete 必须为 true');
    assert.equal(result.truncated, false);
    assert.deepEqual(result.truncationReasons, []);
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

test('端到端截断：页面 URL 达到上限时，collector 透传 partial / complete=false / truncated=true', async () => {
  const base = { url: undefined };
  const { url, close } = await startTestServer(
    createRouter({
      '/manual.xml': () => ({ body: urlsetXml([`${base.url}/g/a`, `${base.url}/g/b`, `${base.url}/g/c`]) }),
    }),
  );
  base.url = url;
  try {
    const result = await collectSite({
      manualSitemapUrl: `${url}/manual.xml`,
      limits: fastLimits({ MAX_PAGE_URLS_PER_SITE: 2 }),
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.complete, false, '被截断的采集结果不允许标记为完整');
    assert.equal(result.truncated, true);
    assert.ok(result.truncationReasons.includes('MAX_PAGE_URLS'));
    assert.equal(result.pageUrlCount, 2);
  } finally {
    await close();
  }
});

test('Milestone 5A-P1：discoveryMode=manual_only 时完全不碰 robots.txt/常见路径', async () => {
  const { url, close } = await startTestServer(
    createRouter({
      '/robots.txt': () => ({ body: 'Sitemap: https://should-not-be-used.test/x.xml' }),
      '/manual.xml': () => ({ body: urlsetXml(['https://example-games.test/g/manual-only-game']) }),
    }),
  );
  try {
    const result = await collectSite({
      siteId: 'lagged',
      baseUrl: url,
      manualSitemaps: [`${url}/manual.xml`],
      discoveryMode: 'manual_only',
      limits: fastLimits(),
    });
    assert.equal(result.status, 'success');
    assert.deepEqual(result.discoveredSitemaps, [`${url}/manual.xml`]);
    assert.deepEqual(result.pageUrls, ['https://example-games.test/g/manual-only-game']);
  } finally {
    await close();
  }
});

test('Milestone 5A-P1：手工 Endpoint 失败时正确产生 partial，不拖累/不伪装其它有效 Endpoint', async () => {
  const base = { url: undefined };
  const { url, close } = await startTestServer(
    createRouter({
      '/robots.txt': () => ({ body: `Sitemap: ${base.url}/good.xml` }),
      '/good.xml': () => ({ body: urlsetXml([`${base.url}/g/a`]) }),
      '/manual-broken.xml': () => ({ status: 404, body: 'not found' }),
    }),
  );
  base.url = url;
  try {
    const result = await collectSite({
      siteId: 'x',
      baseUrl: url,
      manualSitemaps: [`${url}/manual-broken.xml`],
      discoveryMode: 'merge',
      limits: fastLimits(),
    });
    // 手工 Endpoint 失败了，所以整站不能标记为完整 success；但正常的 robots 声明
    // Endpoint 依然正确抓到了它自己的页面 URL，不会被手工 Endpoint 的失败拖累丢失。
    assert.equal(result.status, 'partial');
    assert.equal(result.complete, false, '手工 Endpoint 失败不能被伪装成完整 success');
    assert.deepEqual(result.pageUrls, [`${url}/g/a`], '正常 Endpoint 的页面 URL 不受手工 Endpoint 失败影响');
    assert.ok(result.failedSitemaps.some((e) => e.url === `${url}/manual-broken.xml`));
  } finally {
    await close();
  }
});

test('没有发现任何 Sitemap 入口：状态为 failed，不会抛异常', async () => {
  const { url, close } = await startTestServer(createRouter({}));
  try {
    const result = await collectSite({ baseUrl: url, limits: fastLimits({ COMMON_SITEMAP_PATHS: [] }) });
    assert.equal(result.status, 'failed');
    assert.equal(result.complete, false, 'failed 结果 complete 必须为 false');
    assert.equal(result.truncated, false);
    assert.equal(result.pageUrlCount, 0);
    assert.ok(result.errors.some((e) => e.code === 'NO_SITEMAP_DISCOVERED'));
  } finally {
    await close();
  }
});
