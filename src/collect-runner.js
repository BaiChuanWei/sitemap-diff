import { randomUUID } from 'node:crypto';
import { collectSite } from './sitemap/collector.js';
import {
  createCrawlRun,
  finishCrawlRun,
  persistCompleteSiteResult,
  recordRejectedSiteResult,
  isAdmissible,
} from './storage/index.js';
import { resolveSiteLimits, resolveSiteSitemaps } from './site-overrides.js';

/**
 * 采集运行编排：遍历站点，逐站调用 Milestone 2 采集器，按准入规则决定
 * 是否写入正式 URL 历史，最后汇总成整体运行记录。
 *
 * 关键保证：
 *   - 网络采集在数据库事务之外完成，确认完整后才开短事务写库；
 *   - 单站失败（采集抛错、或写库抛错）不会终止其他站点；
 *   - 只有 isAdmissible 的完整成功结果才更新 seen_urls / added_urls / baseline，
 *     partial / failed / 截断 / 空结果只记录运行诊断。
 *
 * @param sites               站点行数组（至少含 site_id、domain，可选 sitemap_url）
 * @param collectSiteFn       可注入的采集函数（默认 Milestone 2 的 collectSite），便于测试
 * @param limits              全局默认 limits（不传则用 DEFAULT_LIMITS）
 * @param siteLimitOverrides  Milestone 5A-P1：站点级限制覆盖 Map（resolveSiteLimits 用）
 * @param siteSitemapOverrides Milestone 5A-P1：手工 Sitemap 配置 Map（resolveSiteSitemaps 用）
 */
export async function runCollect(
  db,
  { sites, runId = randomUUID(), collectSiteFn = collectSite, limits, siteLimitOverrides, siteSitemapOverrides, now } = {},
) {
  const startedAt = (now && now()) || new Date().toISOString();
  createCrawlRun(db, { runId, startedAt });

  const stats = {
    sitesTotal: sites.length,
    sitesSuccess: 0,
    sitesPartial: 0,
    sitesFailed: 0,
    baselineSiteCount: 0,
    baselineUrlCount: 0,
    addedUrlCount: 0,
  };
  const siteOutcomes = [];
  const errorSummaries = [];

  for (const site of sites) {
    const ts = (now && now()) || new Date().toISOString();
    let result;
    try {
      const resolvedLimits = siteLimitOverrides ? resolveSiteLimits(site.site_id, siteLimitOverrides, limits) : limits;
      const params = buildCollectParams(site, resolvedLimits);
      if (siteSitemapOverrides) {
        const { mode, urls } = resolveSiteSitemaps(site.site_id, siteSitemapOverrides);
        if (urls.length) params.manualSitemaps = urls;
        if (mode) params.discoveryMode = mode;
      }
      result = await collectSiteFn(params);
    } catch (err) {
      // 采集阶段抛错也不能终止整轮：构造一个 failed 结果继续
      result = failedResult(site, err);
    }

    try {
      if (isAdmissible(result)) {
        const persisted = persistCompleteSiteResult(db, { runId, site, result, now: ts });
        stats.sitesSuccess++;
        stats.addedUrlCount += persisted.addedCount;
        if (persisted.isBaseline) {
          stats.baselineSiteCount++;
          stats.baselineUrlCount += persisted.pageUrlCount;
        }
        siteOutcomes.push({ siteId: site.site_id, status: 'success', isBaseline: persisted.isBaseline, added: persisted.addedCount });
      } else {
        recordRejectedSiteResult(db, { runId, site, result, now: ts });
        // 聚合分桶必须以"是否真的彻底失败"（result.status === 'failed'）为准，
        // 不能只识别 'partial' 而把其余全部计入 failed——否则 status=success
        // 但因 pageUrlCount=0 等原因未被准入的结果（如 html5games.com 这类
        // 空内容站点）会被错误计入 sites_failed，而 site_crawl_runs 里持久化
        // 的仍是 status=success，导致汇总统计与逐站表相互矛盾。
        if (result.status === 'failed') stats.sitesFailed++;
        else stats.sitesPartial++;
        siteOutcomes.push({ siteId: site.site_id, status: result.status });
        if (result.errors && result.errors.length) {
          errorSummaries.push(`${site.site_id}: ${result.errors[0].code || 'ERROR'}`);
        }
      }
    } catch (dbErr) {
      // 写库阶段抛错：该站记为失败，但绝不影响其他站点。
      stats.sitesFailed++;
      errorSummaries.push(`${site.site_id}: DB_WRITE_FAILED ${dbErr.message}`);
      try {
        recordRejectedSiteResult(db, {
          runId,
          site,
          result: { ...(result || {}), status: 'failed', complete: false, errors: [{ code: 'DB_WRITE_FAILED', message: dbErr.message }] },
          now: ts,
        });
      } catch {
        // 连诊断记录都写不进去也不再抛，保证循环继续
      }
      siteOutcomes.push({ siteId: site.site_id, status: 'failed' });
    }
  }

  const finishedAt = (now && now()) || new Date().toISOString();
  const overallStatus = stats.sitesFailed === 0 && stats.sitesPartial === 0 ? 'success' : stats.sitesSuccess > 0 ? 'partial' : 'failed';
  finishCrawlRun(db, {
    runId,
    finishedAt,
    status: overallStatus,
    stats,
    errorSummary: errorSummaries.slice(0, 20).join('; ') || null,
  });

  return { runId, status: overallStatus, stats, siteOutcomes };
}

/** 从站点行构造 Milestone 2 采集器的调用参数（domain → baseUrl，sitemap_url → 手工入口）。 */
export function buildCollectParams(site, limits) {
  const params = { siteId: site.site_id, domain: site.domain || null, limits };
  if (site.domain) params.baseUrl = `https://${site.domain}`;
  if (site.sitemap_url) params.manualSitemapUrl = site.sitemap_url;
  return params;
}

function failedResult(site, err) {
  const nowIso = new Date().toISOString();
  return {
    siteId: site.site_id,
    domain: site.domain || null,
    status: 'failed',
    complete: false,
    truncated: false,
    truncationReasons: [],
    startedAt: nowIso,
    finishedAt: nowIso,
    durationMs: 0,
    discoveredSitemaps: [],
    processedSitemaps: [],
    failedSitemaps: [],
    pageUrls: [],
    pageUrlCount: 0,
    sitemapCount: 0,
    warnings: [],
    errors: [{ url: site.domain ? `https://${site.domain}` : null, code: 'COLLECT_THREW', message: err.message }],
  };
}
