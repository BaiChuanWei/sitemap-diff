import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseSite } from '../src/diagnose.js';
import { openDb } from '../src/db/index.js';
import { DEFAULT_LIMITS } from '../src/sitemap/limits.js';
import { parseSiteLimitOverrides, parseSiteSitemapOverrides } from '../src/site-overrides.js';
import { startTestServer, createRouter, urlsetXml } from './helpers/http-server.js';

function fastLimits(overrides = {}) {
  return { ...DEFAULT_LIMITS, REQUEST_TIMEOUT_MS: 300, MAX_RETRIES: 0, RETRY_BASE_DELAY_MS: 1, ...overrides };
}

test('diagnoseSite: 绝不写数据库（baseline/seen_urls/added_urls/url_classifications 均不变化）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm5a-diagnose-'));
  try {
    const db = openDb(join(dir, 'local.db'));
    db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('x', 'x.test', 1)`).run();

    const before = {
      sites: db.prepare('SELECT baseline_completed_at FROM sites WHERE site_id=?').get('x'),
      seen: db.prepare('SELECT COUNT(*) n FROM seen_urls').get().n,
      added: db.prepare('SELECT COUNT(*) n FROM added_urls').get().n,
      cls: db.prepare('SELECT COUNT(*) n FROM url_classifications').get().n,
      crawlRuns: db.prepare('SELECT COUNT(*) n FROM crawl_runs').get().n,
    };

    const { url, close } = await startTestServer(
      createRouter({
        '/robots.txt': () => ({ body: `Sitemap: ${url}/sitemap.xml` }),
        '/sitemap.xml': () => ({ body: urlsetXml([`${url}/g/a`]) }),
      }),
    );
    try {
      const host = new URL(url).host;
      await diagnoseSite({
        site: { site_id: 'x', domain: host },
        limitOverrides: new Map(),
        sitemapOverrides: new Map(),
        // 把诊断构造出的 https://<host>/... 改写回真实的本地 http 测试服务器地址，
        // 避免对着一个不存在的 https 端点发起真实网络请求、拖慢测试。
        fetchImpl: (u, opts) => fetch(String(u).replace(`https://${host}`, url), opts),
      });
    } finally {
      await close();
    }

    const after = {
      sites: db.prepare('SELECT baseline_completed_at FROM sites WHERE site_id=?').get('x'),
      seen: db.prepare('SELECT COUNT(*) n FROM seen_urls').get().n,
      added: db.prepare('SELECT COUNT(*) n FROM added_urls').get().n,
      cls: db.prepare('SELECT COUNT(*) n FROM url_classifications').get().n,
      crawlRuns: db.prepare('SELECT COUNT(*) n FROM crawl_runs').get().n,
    };
    assert.deepEqual(after, before, 'diagnoseSite 不应该改变任何数据库表的内容');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnoseSite: 正常站点返回完整诊断结构，effectiveLimits 反映站点级覆盖', async () => {
  const { url, close } = await startTestServer(
    createRouter({
      '/robots.txt': () => ({ body: `Sitemap: ${url}/sitemap.xml` }),
      '/sitemap.xml': () => ({ body: urlsetXml([`${url}/g/a`, `${url}/g/b`]) }),
    }),
  );
  try {
    const host = new URL(url).host;
    const limitOverrides = parseSiteLimitOverrides([{ site_id: 'x', max_page_urls: '10' }]);
    const diag = await diagnoseSite({
      site: { site_id: 'x', domain: host },
      limitOverrides,
      sitemapOverrides: new Map(),
      fetchImpl: async (u, opts) => fetch(u.replace(`https://${host}`, url), opts),
    });

    assert.equal(diag.effectiveLimits.MAX_PAGE_URLS_PER_SITE, 10);
    assert.equal(diag.discoveryMode, 'auto');
    assert.equal(diag.status, 'success');
    assert.equal(diag.pageUrlCount, 2);
    assert.equal(diag.recommendedAction, 'effective_stable');
    assert.ok(diag.robots.declaredSitemaps.length >= 1);
    assert.ok(Array.isArray(diag.commonPathProbes));
  } finally {
    await close();
  }
});

test('diagnoseSite: manual_only 站点的 discoveryMode 和 manualEndpoints 正确反映配置', async () => {
  const { url, close } = await startTestServer(
    createRouter({
      '/manual.xml': () => ({ body: urlsetXml([`${url}/g/a`]) }),
    }),
  );
  try {
    const sitemapOverrides = parseSiteSitemapOverrides([
      { site_id: 'lagged', sitemap_url: `${url}/manual.xml`, enabled: 'true', mode: 'manual_only', notes: '', verified_at: '' },
    ]);
    const diag = await diagnoseSite({
      site: { site_id: 'lagged', domain: 'lagged.test' },
      limitOverrides: new Map(),
      sitemapOverrides,
      // baseUrl 是假的 lagged.test：诊断命令本身会在 manual_only 模式下依然探测一遍
      // 首页/robots.txt/常见路径以提供上下文（这些探测结果不会被 discoverSitemaps
      // 采用，manual_only 的跳过发生在 collectSite 内部）。这里给非手工 URL 返回一个
      // 快速的假 404，避免真的对不存在的域名发起网络请求、触发重试拖慢测试。
      fetchImpl: async (u, opts) => {
        if (String(u).startsWith(url)) return fetch(u, opts);
        return new Response('not found', { status: 404 });
      },
    });
    assert.equal(diag.discoveryMode, 'manual_only');
    assert.deepEqual(diag.manualEndpoints, [`${url}/manual.xml`]);
    assert.equal(diag.status, 'success');
    assert.equal(diag.pageUrlCount, 1);
  } finally {
    await close();
  }
});
