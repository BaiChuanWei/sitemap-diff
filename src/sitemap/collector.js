import { discoverSitemaps } from './discovery.js';
import { loadSitemapsRecursively } from './recursive-loader.js';
import { DEFAULT_LIMITS } from './limits.js';

/**
 * 采集一个站点：先发现候选 Sitemap 入口，再递归加载，最后拼成
 * Milestone 2 约定的结构化结果。只做采集检查，不写正式 URL 历史。
 *
 * 输入三选一（可以同时提供 baseUrl + manualSitemapUrl）：
 *   - baseUrl：站点根地址，会走 robots.txt 发现 + 常见路径探测
 *   - manualSitemapUrl：手工指定的单个 Sitemap URL（sites.csv 的 sitemap_url 列）
 *   - 两者都提供时会合并去重
 *
 * manualSitemaps（数组，来自 config/site-sitemaps.csv）+ discoveryMode：
 *   - discoveryMode 未设置或 'merge'：手工 Endpoint 与自动发现结果合并去重
 *   - discoveryMode 'manual_only'：完全跳过 robots.txt 声明和常见路径探测
 *
 * 返回结果里的完整性字段：
 *   - status: "success" | "partial" | "failed"
 *   - complete: boolean —— 仅当 status==="success" 时为 true
 *   - truncated: boolean —— 数据是否被主动截断（深度/Endpoint 数/页面 URL 数上限）
 *   - truncationReasons: string[] —— 截断原因，如 MAX_PAGE_URLS / MAX_SITEMAPS_ENDPOINTS / MAX_DEPTH
 *
 * ★ Milestone 3 强制接口契约 ★
 * 只有 status === "success" 且 complete === true（此时 truncated 必为 false）的采集
 * 结果，才允许用于建立或更新正式 baseline / seen URL 历史 / 计算新增 URL。
 * status 为 "partial" / "failed"、complete === false、truncated === true、或页面 URL
 * 数为 0 的结果一律拒绝写入正式 URL 历史，只能记录运行错误和诊断信息（crawl run）。
 * 这条契约由本函数的返回结构保证，具体的写入准入判断由 Milestone 3 的存储层实现。
 */
export async function collectSite({
  siteId,
  domain,
  baseUrl,
  manualSitemapUrl,
  manualSitemaps,
  discoveryMode,
  limits,
  fetchImpl,
} = {}) {
  const effectiveLimits = limits || DEFAULT_LIMITS;
  const startedAt = new Date();

  const discovery = await discoverSitemaps({
    baseUrl,
    manualSitemapUrl,
    manualSitemaps,
    mode: discoveryMode,
    limits: effectiveLimits,
    fetchImpl,
  });

  if (discovery.sitemaps.length === 0) {
    const finishedAt = new Date();
    return {
      siteId: siteId ?? null,
      domain: domain ?? null,
      status: 'failed',
      complete: false,
      truncated: false,
      truncationReasons: [],
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
    complete: loadResult.complete,
    truncated: loadResult.truncated,
    truncationReasons: loadResult.truncationReasons,
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
