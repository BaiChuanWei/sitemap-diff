import { fetchSitemap } from './fetcher.js';
import { DEFAULT_LIMITS } from './limits.js';

const SITEMAP_DIRECTIVE = /^\s*sitemap\s*:\s*(\S+)\s*$/i;

/**
 * 发现一个站点的候选 Sitemap 入口，来源优先级：
 *   1. 手工配置的 sitemap_url
 *   2. robots.txt 里声明的 Sitemap: 条目
 *   3. 仅当以上两者都没有结果时，探测几个常见固定路径
 *
 * 只返回候选 URL 列表和发现来源，不判断这些 URL 是否真的可用——
 * 真正的抓取和成功/失败判定交给 recursive-loader。
 *
 * 返回：{ sitemaps: [{ url, source }], warnings: string[] }
 */
export async function discoverSitemaps({ baseUrl, manualSitemapUrl, limits, fetchImpl } = {}) {
  const effectiveLimits = limits || DEFAULT_LIMITS;
  const seen = new Set();
  const sitemaps = [];
  const warnings = [];

  function add(rawUrl, source) {
    if (!rawUrl) return;
    let normalized;
    try {
      normalized = new URL(rawUrl).toString();
    } catch {
      warnings.push(`忽略无效 URL(${source}): ${rawUrl}`);
      return;
    }
    if (!/^https?:$/.test(new URL(normalized).protocol)) {
      warnings.push(`忽略非 HTTP(S) URL(${source}): ${rawUrl}`);
      return;
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    sitemaps.push({ url: normalized, source });
  }

  if (manualSitemapUrl) add(manualSitemapUrl, 'manual');

  if (baseUrl) {
    let robotsUrl;
    try {
      robotsUrl = new URL('/robots.txt', baseUrl).toString();
    } catch {
      warnings.push(`baseUrl 不是合法 URL: ${baseUrl}`);
      return { sitemaps, warnings };
    }

    const robotsResult = await fetchSitemap(robotsUrl, { limits: effectiveLimits, fetchImpl });
    if (robotsResult.ok && robotsResult.text) {
      const lines = robotsResult.text.split(/\r?\n/);
      for (const line of lines) {
        const match = SITEMAP_DIRECTIVE.exec(line);
        if (!match) continue;
        try {
          add(new URL(match[1].trim(), baseUrl).toString(), 'robots');
        } catch {
          warnings.push(`robots.txt 中的 Sitemap 声明不是合法 URL: ${match[1]}`);
        }
      }
    } else {
      // robots.txt 不存在或不可用不应导致程序崩溃，只记为警告，继续走常见路径探测。
      warnings.push(`robots.txt 不可用(${robotsResult.errorCode || robotsResult.httpStatus}): ${robotsUrl}`);
    }

    if (sitemaps.length === 0) {
      for (const path of effectiveLimits.COMMON_SITEMAP_PATHS) {
        try {
          add(new URL(path, baseUrl).toString(), 'common-path');
        } catch {
          // 理论上不会发生：path 是内置常量、baseUrl 已验证过
        }
      }
    }
  }

  return { sitemaps, warnings };
}
