import { fetchSitemap } from './sitemap/fetcher.js';
import { parseSitemapXml } from './sitemap/parser.js';
import { collectSite } from './sitemap/collector.js';
import { extractRobotsSitemapDirectives } from './sitemap/discovery.js';
import { resolveSiteLimits, resolveSiteSitemaps } from './site-overrides.js';
import { DEFAULT_LIMITS } from './sitemap/limits.js';

/**
 * Milestone 5A-P1：只读诊断命令的核心逻辑。
 *
 * 绝对不写任何数据库表（baseline / seen_urls / added_urls / url_classifications）
 * ——本模块完全不 import src/storage/index.js 或 src/db/index.js，从结构上保证
 * 不可能意外写库。诊断复用与正式 collect 完全相同的限制解析（resolveSiteLimits/
 * resolveSiteSitemaps）和采集逻辑（collectSite），确保"诊断看到的行为"就是
 * "真正采集时会发生的行为"。
 *
 * 只输出安全字段：User-Agent 是唯一发出的请求头（写死在 fetcher.js 里），
 * 不涉及 Cookie/认证 Header/环境变量，因此天然不会泄露到诊断结果。
 */
export async function diagnoseSite({ site, limitOverrides, sitemapOverrides, fetchImpl } = {}) {
  const limits = resolveSiteLimits(site.site_id, limitOverrides, DEFAULT_LIMITS);
  const { mode, urls: manualUrls } = resolveSiteSitemaps(site.site_id, sitemapOverrides);
  const baseUrl = site.domain ? `https://${site.domain}` : undefined;

  const homepage = baseUrl ? await probeUrl(baseUrl, { limits, fetchImpl }) : null;

  let robotsStatus = null;
  let robotsDeclared = [];
  if (baseUrl) {
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    const robotsResult = await fetchSitemap(robotsUrl, { limits, fetchImpl });
    robotsStatus = { url: robotsUrl, httpStatus: robotsResult.httpStatus, ok: robotsResult.ok, errorCode: robotsResult.errorCode };
    if (robotsResult.ok && robotsResult.text) {
      robotsDeclared = extractRobotsSitemapDirectives(robotsResult.text, baseUrl);
    }
  }

  // 常见路径验证：只探测、只记录结果，不代表最终会被 discoverSitemaps 采纳
  // （采纳规则仍然是"只有 robots 和手工都没声明时才会用到常见路径"）。
  const commonPathProbes = [];
  if (baseUrl) {
    for (const path of limits.COMMON_SITEMAP_PATHS || DEFAULT_LIMITS.COMMON_SITEMAP_PATHS) {
      const candidateUrl = new URL(path, baseUrl).toString();
      const probe = await fetchSitemap(candidateUrl, { limits, fetchImpl });
      let validXml = false;
      let xmlRootType = null;
      if (probe.ok) {
        try {
          const parsed = parseSitemapXml(probe.text);
          validXml = true;
          xmlRootType = parsed.type;
        } catch {
          validXml = false;
        }
      }
      commonPathProbes.push({
        url: candidateUrl,
        httpStatus: probe.httpStatus,
        ok: probe.ok,
        validXml,
        xmlRootType,
      });
    }
  }

  // 真正的采集：复用与正式 collect 完全一样的入口，保证诊断结果和正式运行一致。
  const collectResult = await collectSite({
    siteId: site.site_id,
    domain: site.domain || null,
    baseUrl,
    manualSitemapUrl: site.sitemap_url || undefined,
    manualSitemaps: manualUrls.length ? manualUrls : undefined,
    discoveryMode: mode,
    limits,
    fetchImpl,
  });

  const primaryEndpoint = collectResult.processedSitemaps.find((e) => e.status === 'success') || collectResult.processedSitemaps[0] || null;
  const finalError = collectResult.errors[0] || null;

  return {
    site: {
      site_id: site.site_id,
      domain: site.domain || null,
      priority: site.priority || null,
      enabled: site.enabled ?? null,
      robots_url: site.robots_url || null,
      sitemap_url: site.sitemap_url || null,
      expected_game_path: site.expected_game_path || null,
      site_category: site.site_category || null,
    },
    effectiveLimits: limits,
    discoveryMode: mode || 'auto',
    manualEndpoints: manualUrls,
    homepage,
    robots: { ...robotsStatus, declaredSitemaps: robotsDeclared },
    commonPathProbes,
    primaryEndpoint: primaryEndpoint
      ? {
          url: primaryEndpoint.url,
          finalRedirectUrl: primaryEndpoint.url,
          httpStatus: primaryEndpoint.httpStatus,
          contentType: primaryEndpoint.contentType,
          downloadedBytes: primaryEndpoint.downloadedBytes,
          compressed: primaryEndpoint.compressed,
          xmlRootType: primaryEndpoint.type,
          attempts: primaryEndpoint.attempts,
        }
      : null,
    endpointCount: collectResult.sitemapCount,
    pageUrlCount: collectResult.pageUrlCount,
    status: collectResult.status,
    complete: collectResult.complete,
    truncated: collectResult.truncated,
    truncationReasons: collectResult.truncationReasons,
    hitLimits: collectResult.truncationReasons.length > 0,
    errorCode: finalError ? finalError.code : null,
    errorMessage: finalError ? finalError.message : null,
    recommendedAction: recommendAction(collectResult, commonPathProbes, robotsDeclared),
  };
}

async function probeUrl(url, { limits, fetchImpl }) {
  const result = await fetchSitemap(url, { limits, fetchImpl });
  return { url, httpStatus: result.httpStatus, ok: result.ok, errorCode: result.errorCode };
}

/** 简单启发式：只给建议标签，不做任何自动修复决策。 */
function recommendAction(collectResult, commonPathProbes, robotsDeclared) {
  if (collectResult.status === 'success' && collectResult.pageUrlCount > 0 && !collectResult.truncated) {
    return 'effective_stable';
  }
  if (collectResult.status === 'success' && collectResult.pageUrlCount === 0) {
    return 'zero_value';
  }
  if (collectResult.truncated) {
    return 'site_config';
  }
  const finalError = collectResult.errors[0];
  if (finalError) {
    if (finalError.code === 'HTTP_ERROR' && /40[13]/.test(finalError.message || '')) {
      return 'unsupported_access_control';
    }
    if (finalError.code === 'NO_SITEMAP_DISCOVERED') {
      const hasWorkingCommonPath = commonPathProbes.some((p) => p.ok && p.validXml);
      if (hasWorkingCommonPath && robotsDeclared.length > 0) {
        // robots 声明的地址是坏的，但常见路径里有真的能用的——manual_sitemap 候选。
        return 'manual_sitemap';
      }
      return 'unsupported_no_public_sitemap';
    }
  }
  return 'needs_more_evidence';
}
