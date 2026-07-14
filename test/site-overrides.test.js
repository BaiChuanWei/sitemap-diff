import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS } from '../src/sitemap/limits.js';
import {
  parseSiteLimitOverrides,
  resolveSiteLimits,
  parseSiteSitemapOverrides,
  resolveSiteSitemaps,
  LIMIT_HARD_CAPS,
} from '../src/site-overrides.js';

// ---- 站点级限制覆盖 ----

test('未配置覆盖时，resolveSiteLimits 原样返回默认 limits', () => {
  const overrides = parseSiteLimitOverrides([]);
  const resolved = resolveSiteLimits('itch', overrides, DEFAULT_LIMITS);
  assert.equal(resolved, DEFAULT_LIMITS);
});

test('单站限制覆盖只影响该站，其余站点保持默认值', () => {
  const overrides = parseSiteLimitOverrides([
    { site_id: 'kongregate', max_download_bytes: '52428800' }, // 50MB
  ]);
  const kongregate = resolveSiteLimits('kongregate', overrides, DEFAULT_LIMITS);
  const other = resolveSiteLimits('poki', overrides, DEFAULT_LIMITS);

  assert.equal(kongregate.MAX_DOWNLOAD_BYTES, 52428800);
  // 其它字段不受影响，仍是默认值
  assert.equal(kongregate.MAX_PAGE_URLS_PER_SITE, DEFAULT_LIMITS.MAX_PAGE_URLS_PER_SITE);
  assert.equal(other, DEFAULT_LIMITS, '未被覆盖的站点应该原样使用默认 limits 对象');
});

test('max_download_bytes 覆盖生效', () => {
  const overrides = parseSiteLimitOverrides([{ site_id: 'kongregate', max_download_bytes: '60000000' }]);
  const resolved = resolveSiteLimits('kongregate', overrides);
  assert.equal(resolved.MAX_DOWNLOAD_BYTES, 60000000);
});

test('max_page_urls 覆盖生效', () => {
  const overrides = parseSiteLimitOverrides([{ site_id: 'itch', max_page_urls: '900000' }]);
  const resolved = resolveSiteLimits('itch', overrides);
  assert.equal(resolved.MAX_PAGE_URLS_PER_SITE, 900000);
});

test('max_sitemap_endpoints 覆盖生效', () => {
  const overrides = parseSiteLimitOverrides([{ site_id: 'playhop', max_sitemap_endpoints: '400' }]);
  const resolved = resolveSiteLimits('playhop', overrides);
  assert.equal(resolved.MAX_SITEMAPS_PER_SITE, 400);
});

test('非法数字（非整数）被拒绝', () => {
  assert.throws(
    () => parseSiteLimitOverrides([{ site_id: 'x', max_download_bytes: 'abc' }]),
    /不是合法正整数/,
  );
  assert.throws(
    () => parseSiteLimitOverrides([{ site_id: 'x', max_page_urls: '12.5' }]),
    /不是合法正整数/,
  );
});

test('负数和 0 被拒绝', () => {
  assert.throws(() => parseSiteLimitOverrides([{ site_id: 'x', max_depth: '-1' }]), /不是合法正整数/);
  assert.throws(() => parseSiteLimitOverrides([{ site_id: 'x', max_depth: '0' }]), /不是合法正整数/);
});

test('超过程序硬上限被拒绝', () => {
  assert.throws(
    () => parseSiteLimitOverrides([{ site_id: 'x', max_download_bytes: String(LIMIT_HARD_CAPS.max_download_bytes + 1) }]),
    /超过程序硬上限/,
  );
  // 恰好等于硬上限应该被接受
  assert.doesNotThrow(() =>
    parseSiteLimitOverrides([{ site_id: 'x', max_download_bytes: String(LIMIT_HARD_CAPS.max_download_bytes) }]),
  );
});

test('引用未知 site_id 时报错', () => {
  assert.throws(
    () => parseSiteLimitOverrides([{ site_id: 'not-a-real-site', max_depth: '3' }], { knownSiteIds: new Set(['itch', 'poki']) }),
    /未知的 site_id/,
  );
});

test('同一 site_id 重复出现时报错', () => {
  assert.throws(
    () =>
      parseSiteLimitOverrides([
        { site_id: 'itch', max_depth: '3' },
        { site_id: 'itch', max_depth: '4' },
      ]),
    /重复出现/,
  );
});

// ---- 手工 Sitemap 配置 ----

function sitemapRow(overrides = {}) {
  return {
    site_id: 'lagged',
    sitemap_url: 'https://lagged.com/sitemap.xml',
    enabled: 'true',
    mode: 'manual_only',
    notes: '',
    verified_at: '2026-07-14',
    ...overrides,
  };
}

test('manual merge：与自动发现结果合并去重（resolveSiteSitemaps 只负责取值，去重发生在 discovery 层，这里验证配置解析本身的去重）', () => {
  const overrides = parseSiteSitemapOverrides([
    sitemapRow({ mode: 'merge', sitemap_url: 'https://x.com/a.xml' }),
    sitemapRow({ mode: 'merge', sitemap_url: 'https://x.com/a.xml' }), // 完全重复
    sitemapRow({ mode: 'merge', sitemap_url: 'https://x.com/b.xml' }),
  ]);
  const resolved = resolveSiteSitemaps('lagged', overrides);
  assert.equal(resolved.mode, 'merge');
  assert.deepEqual(resolved.urls.sort(), ['https://x.com/a.xml', 'https://x.com/b.xml']);
});

test('manual_only：跳过自动发现由 discovery.js 保证，这里验证 mode 被正确解析为 manual_only', () => {
  const overrides = parseSiteSitemapOverrides([sitemapRow({ mode: 'manual_only' })]);
  const resolved = resolveSiteSitemaps('lagged', overrides);
  assert.equal(resolved.mode, 'manual_only');
  assert.deepEqual(resolved.urls, ['https://lagged.com/sitemap.xml']);
});

test('manual_only 没有任何已启用 Endpoint 时报配置错误', () => {
  assert.throws(
    () => parseSiteSitemapOverrides([sitemapRow({ mode: 'manual_only', enabled: 'false' })]),
    /没有任何已启用.*手工 Endpoint/,
  );
});

test('引用未知 site_id 时报错', () => {
  assert.throws(
    () => parseSiteSitemapOverrides([sitemapRow({ site_id: 'ghost' })], { knownSiteIds: new Set(['lagged']) }),
    /未知的 site_id/,
  );
});

test('非法 URL 被拒绝', () => {
  assert.throws(() => parseSiteSitemapOverrides([sitemapRow({ sitemap_url: 'not-a-url' })]), /不是合法 URL/);
  assert.throws(() => parseSiteSitemapOverrides([sitemapRow({ sitemap_url: 'ftp://x.com/a.xml' })]), /必须是 http\(s\)/);
});

test('非法 mode 被拒绝', () => {
  assert.throws(() => parseSiteSitemapOverrides([sitemapRow({ mode: 'auto' })]), /mode 不合法/);
});

test('同一站点出现不一致的 mode 时报错', () => {
  assert.throws(
    () =>
      parseSiteSitemapOverrides([
        sitemapRow({ mode: 'merge', sitemap_url: 'https://x.com/a.xml' }),
        sitemapRow({ mode: 'manual_only', sitemap_url: 'https://x.com/b.xml' }),
      ]),
    /不一致的 mode/,
  );
});

test('没有任何手工配置的站点，resolveSiteSitemaps 返回 mode=undefined（走默认自动发现）', () => {
  const overrides = parseSiteSitemapOverrides([sitemapRow()]);
  const resolved = resolveSiteSitemaps('some-other-site', overrides);
  assert.equal(resolved.mode, undefined);
  assert.deepEqual(resolved.urls, []);
});

// ---- UTF-8 / 中文内容 round-trip（对应 Windows 中文路径与 UTF-8 配置要求的可测试部分）----

test('notes 字段里的中文内容不影响解析（UTF-8 round-trip）', () => {
  const overrides = parseSiteSitemapOverrides([
    sitemapRow({ notes: '第一批手工配置：已用curl独立验证，2026-07-14实测确认' }),
  ]);
  const resolved = resolveSiteSitemaps('lagged', overrides);
  assert.equal(resolved.mode, 'manual_only');
});
