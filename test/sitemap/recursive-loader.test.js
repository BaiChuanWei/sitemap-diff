import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSitemapsRecursively } from '../../src/sitemap/recursive-loader.js';
import { DEFAULT_LIMITS } from '../../src/sitemap/limits.js';
import { startTestServer, createRouter, urlsetXml, indexXml } from '../helpers/http-server.js';

function fastLimits(overrides = {}) {
  return { ...DEFAULT_LIMITS, REQUEST_TIMEOUT_MS: 300, MAX_RETRIES: 0, RETRY_BASE_DELAY_MS: 1, ...overrides };
}

/** 路由里经常需要引用服务器自己的 base URL 来拼子 Sitemap 链接，
 * 而 base URL 只有 startTestServer resolve 之后才知道，所以用一个延迟赋值
 * 的容器：路由函数在闭包里读 base.url，真正被调用时（收到请求时）base.url
 * 早已经赋值好了。 */
function makeBaseHolder() {
  return { url: undefined };
}

test('一层 Index：递归加载两个子 Sitemap，页面 URL 合并且不含子 Sitemap URL', async () => {
  const base = makeBaseHolder();
  const { url, close } = await startTestServer(
    createRouter({
      '/index.xml': () => ({ body: indexXml([`${base.url}/child-1.xml`, `${base.url}/child-2.xml`]) }),
      '/child-1.xml': () => ({ body: urlsetXml([`${base.url}/g/a`, `${base.url}/g/b`]) }),
      '/child-2.xml': () => ({ body: urlsetXml([`${base.url}/g/c`]) }),
    }),
  );
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/index.xml`, source: 'manual' }],
      limits: fastLimits(),
    });
    assert.equal(result.status, 'success');
    assert.equal(result.sitemapCount, 3);
    assert.equal(result.pageUrlCount, 3);
    assert.deepEqual(
      new Set(result.pageUrls),
      new Set([`${url}/g/a`, `${url}/g/b`, `${url}/g/c`]),
    );
    assert.ok(!result.pageUrls.includes(`${url}/child-1.xml`), '子 Sitemap URL 不应混入页面 URL');
    assert.equal(result.failedSitemaps.length, 0);
    const indexEndpoint = result.processedSitemaps.find((e) => e.url === `${url}/index.xml`);
    assert.equal(indexEndpoint.type, 'sitemapindex');
    assert.equal(indexEndpoint.depth, 0);
    const childEndpoint = result.processedSitemaps.find((e) => e.url === `${url}/child-1.xml`);
    assert.equal(childEndpoint.type, 'urlset');
    assert.equal(childEndpoint.depth, 1);
    assert.equal(childEndpoint.parentUrl, `${url}/index.xml`);
  } finally {
    await close();
  }
});

test('两层嵌套 Index：outer -> inner -> child，深度逐层递增', async () => {
  const base = makeBaseHolder();
  const { url, close } = await startTestServer(
    createRouter({
      '/outer.xml': () => ({ body: indexXml([`${base.url}/inner.xml`]) }),
      '/inner.xml': () => ({ body: indexXml([`${base.url}/child.xml`]) }),
      '/child.xml': () => ({ body: urlsetXml([`${base.url}/g/deep`]) }),
    }),
  );
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/outer.xml` }],
      limits: fastLimits(),
    });
    assert.equal(result.status, 'success');
    assert.equal(result.pageUrlCount, 1);
    assert.deepEqual(result.pageUrls, [`${url}/g/deep`]);

    const byUrl = Object.fromEntries(result.processedSitemaps.map((e) => [e.url, e]));
    assert.equal(byUrl[`${url}/outer.xml`].depth, 0);
    assert.equal(byUrl[`${url}/inner.xml`].depth, 1);
    assert.equal(byUrl[`${url}/child.xml`].depth, 2);
  } finally {
    await close();
  }
});

test('循环引用：a -> b -> a 不会死循环，且不产生假失败', async () => {
  const base = makeBaseHolder();
  const { url, close } = await startTestServer(
    createRouter({
      '/a.xml': () => ({ body: indexXml([`${base.url}/b.xml`]) }),
      '/b.xml': () => ({ body: indexXml([`${base.url}/a.xml`]) }),
    }),
  );
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/a.xml` }],
      limits: fastLimits(),
    });
    assert.equal(result.status, 'success');
    assert.equal(result.sitemapCount, 2, '循环引用应该只各抓取一次 a 和 b');
    assert.equal(result.failedSitemaps.length, 0);
    assert.ok(result.warnings.some((w) => /重复|循环/.test(w)), '应该有循环引用相关的警告');
  } finally {
    await close();
  }
});

test('超过最大递归深度：深度之外的 Endpoint 标记为失败，整体状态为 partial', async () => {
  const base = makeBaseHolder();
  const { url, close } = await startTestServer(
    createRouter({
      '/d0.xml': () => ({ body: indexXml([`${base.url}/d1.xml`]) }),
      '/d1.xml': () => ({ body: indexXml([`${base.url}/d2.xml`]) }),
      '/d2.xml': () => ({ body: indexXml([`${base.url}/d3.xml`]) }),
      '/d3.xml': () => ({ body: urlsetXml([`${base.url}/g/too-deep`]) }),
    }),
  );
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/d0.xml` }],
      limits: fastLimits({ MAX_RECURSION_DEPTH: 2 }),
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.pageUrlCount, 0, 'd3 超过深度限制不应该被抓取');
    const failed = result.failedSitemaps.find((e) => e.url === `${url}/d3.xml`);
    assert.ok(failed, 'd3 应该出现在 failedSitemaps 里');
    assert.equal(failed.errorCode, 'MAX_DEPTH_EXCEEDED');
  } finally {
    await close();
  }
});

test('超过单站最大 Sitemap Endpoint 数：超出部分被跳过而不是当成失败', async () => {
  const base = makeBaseHolder();
  const { url, close } = await startTestServer(
    createRouter({
      '/index.xml': () => ({
        body: indexXml([`${base.url}/child-1.xml`, `${base.url}/child-2.xml`, `${base.url}/child-3.xml`]),
      }),
      '/child-1.xml': () => ({ body: urlsetXml([`${base.url}/g/only-one`]) }),
      '/child-2.xml': () => ({ body: urlsetXml([`${base.url}/g/never-fetched-2`]) }),
      '/child-3.xml': () => ({ body: urlsetXml([`${base.url}/g/never-fetched-3`]) }),
    }),
  );
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/index.xml` }],
      limits: fastLimits({ MAX_SITEMAPS_PER_SITE: 2 }),
    });
    assert.equal(result.sitemapCount, 2, '只应该处理 index + 1 个 child，达到上限就停止');
    assert.equal(result.pageUrlCount, 1);
    assert.ok(result.warnings.some((w) => /最大 Sitemap Endpoint/.test(w)));
  } finally {
    await close();
  }
});

test('子 Sitemap 部分失败：一个成功一个 404，整体状态为 partial', async () => {
  const base = makeBaseHolder();
  const { url, close } = await startTestServer(
    createRouter({
      '/index.xml': () => ({ body: indexXml([`${base.url}/good.xml`, `${base.url}/bad.xml`]) }),
      '/good.xml': () => ({ body: urlsetXml([`${base.url}/g/survivor`]) }),
    }),
  );
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/index.xml` }],
      limits: fastLimits(),
    });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.pageUrls, [`${url}/g/survivor`]);
    const failed = result.failedSitemaps.find((e) => e.url === `${url}/bad.xml`);
    assert.ok(failed);
    assert.equal(failed.httpStatus, 404);
    assert.equal(failed.errorCode, 'HTTP_ERROR');
  } finally {
    await close();
  }
});

test('同一个子 Sitemap 被两个 Index 引用：只抓取一次', async () => {
  const base = makeBaseHolder();
  let fetchCount = 0;
  const { url, close } = await startTestServer(
    createRouter({
      '/index-a.xml': () => ({ body: indexXml([`${base.url}/shared.xml`]) }),
      '/index-b.xml': () => ({ body: indexXml([`${base.url}/shared.xml`]) }),
      '/shared.xml': () => {
        fetchCount++;
        return { body: urlsetXml([`${base.url}/g/shared-game`]) };
      },
    }),
  );
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/index-a.xml` }, { url: `${url}/index-b.xml` }],
      limits: fastLimits(),
    });
    assert.equal(fetchCount, 1, 'shared.xml 应该只被真正请求一次');
    assert.equal(result.sitemapCount, 3);
    assert.deepEqual(result.pageUrls, [`${url}/g/shared-game`]);
  } finally {
    await close();
  }
});

test('页面 URL 跨多个 Sitemap 重复：最终 pageUrls 去重', async () => {
  const base = makeBaseHolder();
  const { url, close } = await startTestServer(
    createRouter({
      '/index.xml': () => ({ body: indexXml([`${base.url}/child-1.xml`, `${base.url}/child-2.xml`]) }),
      '/child-1.xml': () => ({ body: urlsetXml([`${base.url}/g/dup`, `${base.url}/g/only-in-1`]) }),
      '/child-2.xml': () => ({ body: urlsetXml([`${base.url}/g/dup`, `${base.url}/g/only-in-2`]) }),
    }),
  );
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/index.xml` }],
      limits: fastLimits(),
    });
    assert.equal(result.pageUrlCount, 3);
    assert.deepEqual(
      new Set(result.pageUrls),
      new Set([`${url}/g/dup`, `${url}/g/only-in-1`, `${url}/g/only-in-2`]),
    );
  } finally {
    await close();
  }
});

test('同域名并发限制：同一 host 下的请求不会并发超过 PER_HOST_CONCURRENCY', async () => {
  const base = makeBaseHolder();
  let concurrent = 0;
  let maxConcurrent = 0;
  const children = ['c1.xml', 'c2.xml', 'c3.xml'];
  const routes = {
    '/index.xml': () => ({ body: indexXml(children.map((c) => `${base.url}/${c}`)) }),
  };
  for (const c of children) {
    routes[`/${c}`] = () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const start = Date.now();
      while (Date.now() - start < 15) {
        /* 忙等，模拟处理耗时，让并发窗口有机会重叠 */
      }
      concurrent--;
      return { body: urlsetXml([`${base.url}/g/${c}`]) };
    };
  }
  const { url, close } = await startTestServer(createRouter(routes));
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/index.xml` }],
      limits: fastLimits({ PER_HOST_CONCURRENCY: 1, GLOBAL_CONCURRENCY: 5 }),
    });
    assert.equal(result.status, 'success');
    assert.equal(maxConcurrent, 1, '同一域名并发应该被限制为 1');
  } finally {
    await close();
  }
});

test('失败请求可以重试：503 一次后成功，最终该 Endpoint 记为成功', async () => {
  const base = makeBaseHolder();
  let calls = 0;
  const { url, close } = await startTestServer(
    createRouter({
      '/flaky.xml': () => {
        calls++;
        if (calls === 1) return { status: 503, body: 'unavailable' };
        return { body: urlsetXml([`${base.url}/g/recovered`]) };
      },
    }),
  );
  base.url = url;
  try {
    const result = await loadSitemapsRecursively({
      entryPoints: [{ url: `${url}/flaky.xml` }],
      limits: fastLimits({ MAX_RETRIES: 1 }),
    });
    assert.equal(result.status, 'success');
    assert.equal(result.failedSitemaps.length, 0);
    assert.deepEqual(result.pageUrls, [`${url}/g/recovered`]);
  } finally {
    await close();
  }
});
