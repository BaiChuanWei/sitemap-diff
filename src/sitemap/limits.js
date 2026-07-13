/**
 * Sitemap 采集器的全部默认限制，集中定义，禁止把数字散落在多个文件中。
 * 所有接受 limits 参数的函数都应该以此对象为默认值，测试可以传入覆盖版本
 * （例如把超时缩短到几十毫秒）以避免真实等待。
 */
export const DEFAULT_LIMITS = Object.freeze({
  // fetcher.js
  REQUEST_TIMEOUT_MS: 20_000,
  MAX_RETRIES: 2,
  RETRY_BASE_DELAY_MS: 1000,
  MAX_REDIRECTS: 5,
  MAX_DOWNLOAD_BYTES: 20 * 1024 * 1024,
  MAX_DECOMPRESSED_BYTES: 50 * 1024 * 1024,

  // recursive-loader.js
  MAX_RECURSION_DEPTH: 5,
  MAX_SITEMAPS_PER_SITE: 200,
  MAX_PAGE_URLS_PER_SITE: 500_000,

  // 并发
  GLOBAL_CONCURRENCY: 5,
  PER_HOST_CONCURRENCY: 1,

  // discovery.js：常见路径探测，不做大规模目录扫描
  COMMON_SITEMAP_PATHS: Object.freeze(['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml']),
});

export const RETRYABLE_HTTP_STATUSES = Object.freeze([429, 500, 502, 503, 504]);

export const USER_AGENT = 'sitemap-diff-local/0.1 (+local sitemap monitor)';
