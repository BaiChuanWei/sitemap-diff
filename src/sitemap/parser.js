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
 * options.baseUrl：可选，该 Sitemap 文件自身的 URL。Sitemap 协议规范要求
 * <loc> 必须是绝对 URL，但真实站点里确实存在用根相对路径（如 <loc>/g/x</loc>，
 * 例如 julgames.com）的情况。传入 baseUrl 后，只有明确像根相对路径
 * （以 / 开头、不含空白）的 <loc> 才会按浏览器解析相对链接的方式解析成
 * 绝对 URL；不传 baseUrl 或不像路径的字符串，行为与之前完全一致（忽略）。
 *
 * 返回：{ type: 'urlset' | 'sitemapindex', locations: string[], warnings: string[] }
 * locations 已经在本文件范围内去重（同一份 XML 内的重复 <loc>）。
 */
export function parseSitemapXml(xmlText, options = {}) {
  const { baseUrl } = options;

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
    return extractLocSet(parsed.urlset, 'url', '缺少合法 <loc>，已忽略该 <url> 条目', 'urlset', baseUrl);
  }

  if (parsed.sitemapindex !== undefined) {
    return extractLocSet(parsed.sitemapindex, 'sitemap', '缺少合法 <loc>，已忽略该 <sitemap> 条目', 'sitemapindex', baseUrl);
  }

  const rootKeys = Object.keys(parsed).filter((k) => k !== '?xml');
  throw new SitemapParseError(
    PARSE_ERROR_CODES.UNKNOWN_ROOT,
    `未知的 XML 根元素: ${rootKeys.join(', ') || '(空文档)'}`,
  );
}

function extractLocSet(root, childKey, warningText, type, baseUrl) {
  const entries = normalizeArray(root?.[childKey]);
  const seen = new Set();
  const locations = [];
  const warnings = [];

  for (const entry of entries) {
    const loc = extractLoc(entry, baseUrl);
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

function extractLoc(entry, baseUrl) {
  if (entry === undefined || entry === null) return null;
  let loc = typeof entry === 'object' ? entry.loc : undefined;
  if (loc && typeof loc === 'object') loc = loc['#text'];
  if (typeof loc !== 'string') return null;
  const trimmed = loc.trim();
  return resolveHttpUrl(trimmed, baseUrl);
}

function resolveHttpUrl(value, baseUrl) {
  const absolute = tryParseHttpUrl(value);
  if (absolute) return absolute;
  // 只有明确像根相对路径的字符串（以 / 开头、不含空白）才尝试相对解析，
  // 避免把不相关的乱码文本误当成 URL。
  if (baseUrl && /^\/\S*$/.test(value)) {
    return tryParseHttpUrl(value, baseUrl);
  }
  return null;
}

function tryParseHttpUrl(value, base) {
  try {
    const u = base ? new URL(value, base) : new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
