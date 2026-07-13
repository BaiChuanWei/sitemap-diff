import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { SitemapParseError, PARSE_ERROR_CODES } from './errors.js';

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
});

/**
 * 解析一份 Sitemap XML 文本，区分 urlset 和 sitemapindex。
 * 未知根元素、无法解析的 XML 都会抛出 SitemapParseError，不做猜测。
 *
 * 返回：{ type: 'urlset' | 'sitemapindex', locations: string[], warnings: string[] }
 * locations 已经在本文件范围内去重（同一份 XML 内的重复 <loc>）。
 */
export function parseSitemapXml(xmlText) {
  const validation = XMLValidator.validate(xmlText, { allowBooleanAttributes: true });
  if (validation !== true) {
    const detail = validation?.err?.msg || '未知的 XML 格式错误';
    throw new SitemapParseError(PARSE_ERROR_CODES.INVALID_XML, `XML 格式无效: ${detail}`);
  }

  let parsed;
  try {
    parsed = xmlParser.parse(xmlText);
  } catch (err) {
    throw new SitemapParseError(PARSE_ERROR_CODES.INVALID_XML, `XML 解析失败: ${err.message}`);
  }

  if (parsed.urlset !== undefined) {
    return extractLocSet(parsed.urlset, 'url', '缺少合法 <loc>，已忽略该 <url> 条目', 'urlset');
  }

  if (parsed.sitemapindex !== undefined) {
    return extractLocSet(parsed.sitemapindex, 'sitemap', '缺少合法 <loc>，已忽略该 <sitemap> 条目', 'sitemapindex');
  }

  const rootKeys = Object.keys(parsed).filter((k) => k !== '?xml');
  throw new SitemapParseError(
    PARSE_ERROR_CODES.UNKNOWN_ROOT,
    `未知的 XML 根元素: ${rootKeys.join(', ') || '(空文档)'}`,
  );
}

function extractLocSet(root, childKey, warningText, type) {
  const entries = normalizeArray(root?.[childKey]);
  const seen = new Set();
  const locations = [];
  const warnings = [];

  for (const entry of entries) {
    const loc = extractLoc(entry);
    if (!loc) {
      warnings.push(warningText);
      continue;
    }
    if (seen.has(loc)) continue;
    seen.add(loc);
    locations.push(loc);
  }

  return { type, locations, warnings };
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractLoc(entry) {
  if (entry === undefined || entry === null) return null;
  let loc = typeof entry === 'object' ? entry.loc : undefined;
  if (loc && typeof loc === 'object') loc = loc['#text'];
  if (typeof loc !== 'string') return null;
  const trimmed = loc.trim();
  return isHttpUrl(trimmed) ? trimmed : null;
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
