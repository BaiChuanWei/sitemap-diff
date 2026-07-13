import pLimit from 'p-limit';
import { fetchSitemap } from '../sitemap/fetcher.js';
import { DEFAULT_LIMITS } from '../sitemap/limits.js';
import { extractPageMeta } from './page-meta.js';

/**
 * 抓取一批页面 URL 以获取分类用的元数据，复用 Milestone 2 的 fetcher
 * （超时 / 重试 / 429 退避 / 大小上限 / Gzip 检测）和默认限制，避免另起一套
 * 不一致的网络层。在其上加全局 + 同域名两级并发限制（同 recursive-loader）。
 *
 * 只抓取传入的 URL（调用方保证只传本轮新增 URL），不抓历史全量。
 *
 * @returns Map<url, { ok: true, meta } | { ok: false, errorCode }>
 */
export async function fetchPages(urls, { limits = DEFAULT_LIMITS, fetchImpl } = {}) {
  const globalLimiter = pLimit(limits.GLOBAL_CONCURRENCY);
  const hostLimiters = new Map();
  const out = new Map();

  function hostLimiterFor(url) {
    let host;
    try {
      host = new URL(url).host;
    } catch {
      host = '(invalid)';
    }
    if (!hostLimiters.has(host)) hostLimiters.set(host, pLimit(limits.PER_HOST_CONCURRENCY));
    return hostLimiters.get(host);
  }

  await Promise.all(
    urls.map((url) =>
      globalLimiter(() =>
        hostLimiterFor(url)(async () => {
          const res = await fetchSitemap(url, { limits, fetchImpl });
          if (res.ok) out.set(url, { ok: true, meta: extractPageMeta(res.text) });
          else out.set(url, { ok: false, errorCode: res.errorCode || 'PAGE_FETCH_FAILED' });
        }),
      ),
    ),
  );

  return out;
}
