import { DEFAULT_LIMITS } from './sitemap/limits.js';

/**
 * Milestone 5A-P1：站点级限制覆盖 + 手工 Sitemap 配置的解析与合并。
 *
 * 两份配置文件都是可选的：不存在时等同于"没有任何站点有覆盖"，不报错、
 * 不影响任何默认行为。文件存在但内容有问题（非法数字、超硬上限、引用未知
 * site_id、mode 不合法等）时必须明确抛错，不允许静默退化成危险值。
 */

/** CSV 列名 -> DEFAULT_LIMITS 字段名。只开放这 6 个，其余限制不可通过站点配置覆盖。 */
export const LIMIT_FIELD_MAP = Object.freeze({
  max_download_bytes: 'MAX_DOWNLOAD_BYTES',
  max_decompressed_bytes: 'MAX_DECOMPRESSED_BYTES',
  max_page_urls: 'MAX_PAGE_URLS_PER_SITE',
  max_sitemap_endpoints: 'MAX_SITEMAPS_PER_SITE',
  max_depth: 'MAX_RECURSION_DEPTH',
  request_timeout_ms: 'REQUEST_TIMEOUT_MS',
});

/** 程序级硬上限：任何站点配置都不能突破，防止无限资源消耗。 */
export const LIMIT_HARD_CAPS = Object.freeze({
  max_download_bytes: 100 * 1024 * 1024,
  max_decompressed_bytes: 250 * 1024 * 1024,
  max_page_urls: 1_500_000,
  max_sitemap_endpoints: 1000,
  max_depth: 10,
  request_timeout_ms: 60_000,
});

export const SITE_LIMITS_CSV_HEADERS = Object.freeze([
  'site_id',
  ...Object.keys(LIMIT_FIELD_MAP),
]);

export const SITE_SITEMAPS_CSV_HEADERS = Object.freeze([
  'site_id',
  'sitemap_url',
  'enabled',
  'mode',
  'notes',
  'verified_at',
]);

/**
 * 解析 config/site-limits.csv 的记录数组（已经过 parseSitesCsv 解析）为
 * Map<site_id, 覆盖片段>。覆盖片段的 key 已经是 DEFAULT_LIMITS 的字段名，
 * 值都经过整数/范围/硬上限校验。
 *
 * @param rows          parseSitesCsv() 的输出
 * @param knownSiteIds  可选：合法 site_id 集合，传入后会拒绝未知 site_id
 */
export function parseSiteLimitOverrides(rows, { knownSiteIds } = {}) {
  const map = new Map();
  for (const row of rows) {
    const siteId = row.site_id;
    if (!siteId) {
      throw new Error('config/site-limits.csv 有一行缺少 site_id');
    }
    if (knownSiteIds && !knownSiteIds.has(siteId)) {
      throw new Error(`config/site-limits.csv 引用了未知的 site_id: ${siteId}`);
    }
    if (map.has(siteId)) {
      throw new Error(`config/site-limits.csv 中 site_id=${siteId} 重复出现，一个站点只能有一行`);
    }

    const override = {};
    for (const [csvField, limitKey] of Object.entries(LIMIT_FIELD_MAP)) {
      const raw = row[csvField];
      if (raw === undefined || raw === '') continue; // 未填写 = 保持默认值
      try {
        override[limitKey] = validateLimitFieldValue(csvField, raw);
      } catch (err) {
        throw new Error(`config/site-limits.csv 中 site_id=${siteId} 的 ${err.message}`);
      }
    }
    map.set(siteId, override);
  }
  return map;
}

/**
 * 校验单个限制字段的值（正整数、不超硬上限），CSV 解析路径和 Dashboard M2
 * 的 JSON API 写入路径共用这一份规则，不允许出现两套不同的校验逻辑。
 * 返回校验通过的整数；失败时抛出的 Error.message 只包含"字段名不合法
 * 原因"这一段，方便两个调用方各自拼出符合自己上下文的完整提示。
 */
export function validateLimitFieldValue(csvField, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error(`${csvField} 不是合法正整数: "${raw}"`);
    err.code = 'INVALID_INTEGER';
    throw err;
  }
  const cap = LIMIT_HARD_CAPS[csvField];
  if (n > cap) {
    const err = new Error(`${csvField}=${n} 超过程序硬上限 ${cap}`);
    err.code = 'OVER_HARD_CAP';
    throw err;
  }
  return n;
}

/** 用某个站点的覆盖片段合并出最终生效的 limits 对象；没有覆盖时原样返回 defaultLimits。 */
export function resolveSiteLimits(siteId, overridesMap, defaultLimits = DEFAULT_LIMITS) {
  const override = overridesMap?.get(siteId);
  if (!override || Object.keys(override).length === 0) return defaultLimits;
  return Object.freeze({ ...defaultLimits, ...override });
}

const TRUE_STRINGS = new Set(['true', '1', 'yes']);

/**
 * 解析 config/site-sitemaps.csv 的记录数组为 Map<site_id, { mode, urls }>。
 * urls 只包含 enabled=true 的行；mode 是站点级属性——同一 site_id 的所有行
 * 必须声明相同的 mode，否则报错（避免"这行 merge、那行 manual_only"的歧义）。
 */
export function parseSiteSitemapOverrides(rows, { knownSiteIds } = {}) {
  const bySite = new Map();

  for (const row of rows) {
    const siteId = row.site_id;
    if (!siteId) {
      throw new Error('config/site-sitemaps.csv 有一行缺少 site_id');
    }
    if (knownSiteIds && !knownSiteIds.has(siteId)) {
      throw new Error(`config/site-sitemaps.csv 引用了未知的 site_id: ${siteId}`);
    }
    const mode = row.mode;
    if (mode !== 'merge' && mode !== 'manual_only') {
      throw new Error(
        `config/site-sitemaps.csv 中 site_id=${siteId} 的 mode 不合法（只能是 merge 或 manual_only）: "${mode}"`,
      );
    }

    let normalizedUrl;
    try {
      normalizedUrl = new URL(row.sitemap_url).toString();
    } catch {
      throw new Error(`config/site-sitemaps.csv 中 site_id=${siteId} 的 sitemap_url 不是合法 URL: "${row.sitemap_url}"`);
    }
    if (!/^https?:$/.test(new URL(normalizedUrl).protocol)) {
      throw new Error(`config/site-sitemaps.csv 中 site_id=${siteId} 的 sitemap_url 必须是 http(s): "${row.sitemap_url}"`);
    }

    if (!bySite.has(siteId)) bySite.set(siteId, { mode, urls: new Set() });
    const entry = bySite.get(siteId);
    if (entry.mode !== mode) {
      throw new Error(
        `config/site-sitemaps.csv 中 site_id=${siteId} 出现了不一致的 mode（已有 ${entry.mode}，又出现 ${mode}），同一站点的 mode 必须一致`,
      );
    }

    const enabled = TRUE_STRINGS.has(String(row.enabled).toLowerCase());
    if (enabled) entry.urls.add(normalizedUrl); // Set 自动去重
  }

  const result = new Map();
  for (const [siteId, entry] of bySite) {
    if (entry.mode === 'manual_only' && entry.urls.size === 0) {
      throw new Error(
        `config/site-sitemaps.csv 中 site_id=${siteId} 的 mode=manual_only 但没有任何已启用(enabled=true)的手工 Endpoint`,
      );
    }
    result.set(siteId, { mode: entry.mode, urls: [...entry.urls] });
  }
  return result;
}

/** 取某个站点的手工 Sitemap 配置；没有配置时返回 mode=undefined（表示走默认自动发现）。 */
export function resolveSiteSitemaps(siteId, overridesMap) {
  const entry = overridesMap?.get(siteId);
  if (!entry) return { mode: undefined, urls: [] };
  return entry;
}
