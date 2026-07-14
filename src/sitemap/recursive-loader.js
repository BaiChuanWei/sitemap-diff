import pLimit from 'p-limit';
import { fetchSitemap } from './fetcher.js';
import { parseSitemapXml } from './parser.js';
import { SitemapParseError } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';

/**
 * 递归加载一组入口 Sitemap（含 Sitemap Index 的多层递归），带 visited set
 * 循环保护、深度/Endpoint 数/页面 URL 数上限，以及全局 + 同域名并发限制。
 *
 * 子 Sitemap URL 只用于继续递归，绝不会混入 pageUrls。
 *
 * 返回：
 * {
 *   status: 'success' | 'partial' | 'failed',
 *   processedSitemaps: Endpoint[],
 *   failedSitemaps: Endpoint[],
 *   pageUrls: string[],
 *   pageUrlCount, sitemapCount, warnings, errors
 * }
 */
export async function loadSitemapsRecursively({ entryPoints, limits, fetchImpl } = {}) {
  const effectiveLimits = limits || DEFAULT_LIMITS;
  const globalLimiter = pLimit(effectiveLimits.GLOBAL_CONCURRENCY);
  const hostLimiters = new Map();

  const visited = new Set();
  const pageUrls = new Set();
  const processedSitemaps = [];
  const failedSitemaps = [];
  const warnings = [];
  const errors = [];
  // 记录"数据被主动截断"的原因：任何一个非空都意味着本次采集结果不完整
  // （complete=false），后续 Milestone 3 不得用这样的结果建立/更新 baseline。
  const truncationReasons = new Set();
  let sitemapCount = 0;
  let pageUrlLimitWarned = false;
  let sitemapLimitWarned = false;

  function hostLimiterFor(url) {
    let host;
    try {
      host = new URL(url).host;
    } catch {
      host = '(invalid)';
    }
    if (!hostLimiters.has(host)) {
      hostLimiters.set(host, pLimit(effectiveLimits.PER_HOST_CONCURRENCY));
    }
    return hostLimiters.get(host);
  }

  async function crawl(item) {
    const normalized = normalizeUrl(item.url);
    if (!normalized) {
      recordFailure(item, { errorCode: 'INVALID_URL', errorMessage: `不是合法的 URL: ${item.url}` });
      return;
    }

    // 循环保护 + 去重：check 和 add 之间不能有 await，避免并发下的竞态。
    if (visited.has(normalized)) {
      warnings.push(`跳过重复/循环引用的 Sitemap: ${normalized}`);
      return;
    }
    visited.add(normalized);

    if (item.depth > effectiveLimits.MAX_RECURSION_DEPTH) {
      truncationReasons.add('MAX_DEPTH');
      recordFailure(item, {
        status: 'skipped',
        errorCode: 'MAX_DEPTH_EXCEEDED',
        errorMessage: `超过最大递归深度(${effectiveLimits.MAX_RECURSION_DEPTH})`,
      });
      return;
    }

    if (sitemapCount >= effectiveLimits.MAX_SITEMAPS_PER_SITE) {
      truncationReasons.add('MAX_SITEMAPS_ENDPOINTS');
      if (!sitemapLimitWarned) {
        sitemapLimitWarned = true;
        warnings.push(`达到单站最大 Sitemap Endpoint 数限制(${effectiveLimits.MAX_SITEMAPS_PER_SITE})`);
      }
      return;
    }
    sitemapCount++;

    const globalTask = () =>
      hostLimiterFor(normalized)(() => fetchSitemap(normalized, { limits: effectiveLimits, fetchImpl }));
    const fetchResult = await globalLimiter(globalTask);

    if (!fetchResult.ok) {
      recordFailure(item, {
        httpStatus: fetchResult.httpStatus,
        contentType: fetchResult.contentType,
        compressed: fetchResult.compressed,
        errorCode: fetchResult.errorCode,
        errorMessage: fetchResult.errorMessage,
        attempts: fetchResult.attempts,
      });
      errors.push({ url: normalized, code: fetchResult.errorCode, message: fetchResult.errorMessage });
      return;
    }

    let parsed;
    try {
      parsed = parseSitemapXml(fetchResult.text);
    } catch (err) {
      const code = err instanceof SitemapParseError ? err.code : 'PARSE_ERROR';
      recordFailure(item, {
        httpStatus: fetchResult.httpStatus,
        contentType: fetchResult.contentType,
        compressed: fetchResult.compressed,
        type: 'unknown',
        errorCode: code,
        errorMessage: err.message,
        attempts: fetchResult.attempts,
      });
      errors.push({ url: normalized, code, message: err.message });
      return;
    }

    processedSitemaps.push(
      makeEndpoint(item, {
        status: 'success',
        httpStatus: fetchResult.httpStatus,
        contentType: fetchResult.contentType,
        compressed: fetchResult.compressed,
        type: parsed.type,
        locationCount: parsed.locations.length,
        attempts: fetchResult.attempts,
      }),
    );
    for (const w of parsed.warnings) warnings.push(`${normalized}: ${w}`);

    if (parsed.type === 'urlset') {
      for (const loc of parsed.locations) {
        if (pageUrls.size >= effectiveLimits.MAX_PAGE_URLS_PER_SITE) {
          truncationReasons.add('MAX_PAGE_URLS');
          if (!pageUrlLimitWarned) {
            pageUrlLimitWarned = true;
            warnings.push(`达到单站最大页面 URL 数限制(${effectiveLimits.MAX_PAGE_URLS_PER_SITE})`);
          }
          break;
        }
        pageUrls.add(loc);
      }
      return;
    }

    // sitemapindex：子 Sitemap URL 只用于继续递归，不进入 pageUrls。
    await Promise.all(
      parsed.locations.map((childUrl) =>
        crawl({ url: childUrl, parentUrl: normalized, depth: item.depth + 1 }),
      ),
    );
  }

  function recordFailure(item, fields) {
    const endpoint = makeEndpoint(item, { status: fields.status || 'failed', ...fields });
    failedSitemaps.push(endpoint);
    processedSitemaps.push(endpoint);
  }

  await Promise.all(entryPoints.map((ep) => crawl({ url: ep.url, parentUrl: null, depth: 0 })));

  const hasSuccess = processedSitemaps.some((e) => e.status === 'success');
  const hasFailure = failedSitemaps.length > 0;
  const truncated = truncationReasons.size > 0;

  // status/complete 语义（Milestone 2 收尾修正）：
  //   success + complete=true  仅当：有成功、无失败、无截断——数据可视为完整；
  //   partial                  有成功，但发生了失败或截断——数据不完整；
  //   failed                   没有任何成功的 Endpoint。
  // complete 只在 status===success 时为 true；任何截断都会把 success 降级为 partial，
  // 从而杜绝"被截断却标记为完整"的假完整结果。
  let status;
  if (hasSuccess && !hasFailure && !truncated) {
    status = 'success';
  } else if (hasSuccess) {
    status = 'partial';
  } else {
    status = 'failed';
  }
  const complete = status === 'success';

  return {
    status,
    complete,
    truncated,
    truncationReasons: [...truncationReasons],
    processedSitemaps,
    failedSitemaps,
    pageUrls: [...pageUrls],
    pageUrlCount: pageUrls.size,
    sitemapCount,
    warnings,
    errors,
  };
}

function makeEndpoint(item, fields) {
  return {
    url: item.url,
    parentUrl: item.parentUrl,
    depth: item.depth,
    type: fields.type || 'unknown',
    status: fields.status || 'failed',
    httpStatus: fields.httpStatus ?? null,
    contentType: fields.contentType ?? null,
    compressed: fields.compressed ?? false,
    locationCount: fields.locationCount ?? 0,
    errorCode: fields.errorCode ?? null,
    errorMessage: fields.errorMessage ?? null,
    // fetchSitemap() 内部本来就统计了这个 URL 总共尝试了几次（1 = 一次成功，
    // >1 = 发生过重试）；这里只是把已有的数据透传出来，不新增任何重试逻辑。
    attempts: fields.attempts ?? null,
  };
}

function normalizeUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}
