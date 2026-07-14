import { fetchSitemap } from './fetcher.js';
import { parseSitemapXml } from './parser.js';
import { DEFAULT_LIMITS } from './limits.js';

const SITEMAP_DIRECTIVE = /^\s*sitemap\s*:\s*(\S+)\s*$/i;

/** 从 robots.txt 文本里提取所有 `Sitemap:` 声明，解析成绝对 URL 列表（不做网络请求）。 */
export function extractRobotsSitemapDirectives(robotsText, baseUrl) {
  const declared = [];
  const lines = (robotsText || '').split(/\r?\n/);
  for (const line of lines) {
    const match = SITEMAP_DIRECTIVE.exec(line);
    if (!match) continue;
    try {
      declared.push(new URL(match[1].trim(), baseUrl).toString());
    } catch {
      // 忽略不合法的声明，调用方（discoverSitemaps）会记录警告；这里只做纯解析。
    }
  }
  return declared;
}

/**
 * 发现一个站点的候选 Sitemap 入口，来源优先级：
 *   1. 手工配置的 sitemap_url（单个，向后兼容 sites.csv 的 sitemap_url 列）
 *   2. 手工配置的多 Endpoint 列表（config/site-sitemaps.csv）
 *   3. robots.txt 里声明的 Sitemap: 条目
 *   4. 仅当以上都没有结果时，探测几个常见固定路径
 *
 * mode==='manual_only' 时完全跳过 robots.txt 声明和常见路径探测，只使用手工
 * 配置的 Endpoint（manualSitemapUrl / manualSitemaps）。
 *
 * 只返回候选 URL 列表和发现来源，不判断这些 URL 是否真的可用——
 * 真正的抓取和成功/失败判定交给 recursive-loader。
 *
 * 返回：{ sitemaps: [{ url, source }], warnings: string[] }
 */
export async function discoverSitemaps({ baseUrl, manualSitemapUrl, manualSitemaps, mode, limits, fetchImpl } = {}) {
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
  if (manualSitemaps) for (const u of manualSitemaps) add(u, 'manual-config');

  if (mode === 'manual_only') {
    // manual_only：完全不碰 robots.txt 和常见路径猜测，哪怕手工列表最终是空的
    // 也不能退回自动发现——那样会违背"只使用经过验证的手工 Endpoint"的约定。
    // （手工列表为空是配置阶段就该拒绝的错误，这里只负责遵守约定本身。）
    return { sitemaps, warnings };
  }

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
      // 常见路径是纯猜测，不像手工配置或 robots.txt 声明那样代表"已确认存在"。
      // 猜错的路径（404，或 200 但内容根本不是合法 Sitemap）必须静默跳过，
      // 不能冒充"发现结果"往下传——否则 recursive-loader 会把这些必然失败的
      // 候选当成真实 Endpoint 失败，把明明完整、正常的站点拖成 partial
      // （真实案例：coolmathgames.com 只有 /sitemap.xml 存在，另外两个猜测
      // 路径 404；brainrot-games.io 的猜测路径返回 200 但 Content-Length:0）。
      for (const path of effectiveLimits.COMMON_SITEMAP_PATHS) {
        let candidateUrl;
        try {
          candidateUrl = new URL(path, baseUrl).toString();
        } catch {
          continue; // 理论上不会发生：path 是内置常量、baseUrl 已验证过
        }
        const probe = await fetchSitemap(candidateUrl, { limits: effectiveLimits, fetchImpl });
        if (!probe.ok) continue;
        try {
          parseSitemapXml(probe.text);
        } catch {
          continue;
        }
        add(candidateUrl, 'common-path');
      }
    }
  }

  return { sitemaps, warnings };
}
