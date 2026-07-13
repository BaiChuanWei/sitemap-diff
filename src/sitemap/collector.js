import { discoverSitemaps } from './discovery.js';
import { loadSitemapsRecursively } from './recursive-loader.js';
import { DEFAULT_LIMITS } from './limits.js';

/**
 * 采集一个站点：先发现候选 Sitemap 入口，再递归加载，最后拼成
 * Milestone 2 约定的结构化结果。只做采集检查，不写正式 URL 历史。
 *
 * 输入三选一（可以同时提供 baseUrl + manualSitemapUrl）：
 *   - baseUrl：站点根地址，会走 robots.txt 发现 + 常见路径探测
 *   - manualSitemapUrl：手工指定的 Sitemap URL
 *   - 两者都提供时会合并去重
 */
export async function collectSite({ siteId, domain, baseUrl, manualSitemapUrl, limits, fetchImpl } = {}) {
  const effectiveLimits = limits || DEFAULT_LIMITS;
  const startedAt = new Date();

  const discovery = await discoverSitemaps({ baseUrl, manualSitemapUrl, limits: effectiveLimits, fetchImpl });

  if (discovery.sitemaps.length === 0) {
    const finishedAt = new Date();
    return {
      siteId: siteId ?? null,
      domain: domain ?? null,
      status: 'failed',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      discoveredSitemaps: [],
      processedSitemaps: [],
      failedSitemaps: [],
      pageUrls: [],
      pageUrlCount: 0,
      sitemapCount: 0,
      warnings: discovery.warnings,
      errors: [{ url: baseUrl || manualSitemapUrl || null, code: 'NO_SITEMAP_DISCOVERED', message: '没有发现任何 Sitemap 入口' }],
    };
  }

  const loadResult = await loadSitemapsRecursively({
    entryPoints: discovery.sitemaps,
    limits: effectiveLimits,
    fetchImpl,
  });

  const finishedAt = new Date();

  return {
    siteId: siteId ?? null,
    domain: domain ?? null,
    status: loadResult.status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    discoveredSitemaps: discovery.sitemaps.map((s) => s.url),
    processedSitemaps: loadResult.processedSitemaps,
    failedSitemaps: loadResult.failedSitemaps,
    pageUrls: loadResult.pageUrls,
    pageUrlCount: loadResult.pageUrlCount,
    sitemapCount: loadResult.sitemapCount,
    warnings: [...discovery.warnings, ...loadResult.warnings],
    errors: loadResult.errors,
  };
}
