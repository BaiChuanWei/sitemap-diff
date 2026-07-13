/**
 * 轻量 HTML 元数据提取（不引入重型 HTML 解析依赖，用正则做保守提取）。
 * 提取 <title>、第一个 <h1>、og:title、canonical、JSON-LD 的 @type 列表。
 * 这些只作为分类的交叉证据，提取失败不影响流程（返回尽力而为的结果）。
 */
export function extractPageMeta(html) {
  if (typeof html !== 'string') return emptyMeta();

  const title = clean(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const h1 = clean(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));
  const ogTitle = clean(
    firstMatch(html, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i) ||
      firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i),
  );
  const canonical = firstMatch(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) || null;

  const jsonLdTypes = extractJsonLdTypes(html);

  return { title, h1, ogTitle, canonical, jsonLdTypes };
}

function extractJsonLdTypes(html) {
  const types = new Set();
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    collectTypes(data, types);
  }
  return [...types];
}

function collectTypes(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out);
    return;
  }
  const t = node['@type'];
  if (typeof t === 'string') out.add(t.toLowerCase());
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x.toLowerCase());
  for (const key of Object.keys(node)) {
    if (key === '@type') continue;
    collectTypes(node[key], out);
  }
}

function firstMatch(s, re) {
  const m = s.match(re);
  return m ? m[1] : null;
}

function clean(s) {
  if (!s) return null;
  const text = s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function emptyMeta() {
  return { title: null, h1: null, ogTitle: null, canonical: null, jsonLdTypes: [] };
}

const GAME_JSONLD_TYPES = new Set(['videogame', 'game', 'softwareapplication']);

/**
 * 计算页面元数据能给出的交叉证据。
 * @param meta      extractPageMeta 的结果
 * @param candidate extractGameCandidate 的结果（可能为 null）
 * @returns string[] 证据码，如 'title_matches_slug' / 'h1_matches_slug' /
 *          'og_title_matches_slug' / 'jsonld_game'
 */
export function matchMeta(meta, candidate) {
  const evidence = [];
  if (!meta) return evidence;

  if (meta.jsonLdTypes && meta.jsonLdTypes.some((t) => GAME_JSONLD_TYPES.has(t))) {
    evidence.push('jsonld_game');
  }

  if (candidate && candidate.cleanName) {
    const slugWords = candidate.cleanName.split('-').filter((w) => w.length >= 2);
    if (slugWords.length > 0) {
      if (textContainsSlug(meta.title, slugWords)) evidence.push('title_matches_slug');
      if (textContainsSlug(meta.h1, slugWords)) evidence.push('h1_matches_slug');
      if (textContainsSlug(meta.ogTitle, slugWords)) evidence.push('og_title_matches_slug');
    }
  }

  return evidence;
}

function textContainsSlug(text, slugWords) {
  if (!text) return false;
  const norm = text.toLowerCase();
  // 要求 slug 的大部分词都出现在文本中，避免单个常见词误命中。
  const hit = slugWords.filter((w) => norm.includes(w)).length;
  return hit >= Math.ceil(slugWords.length * 0.6);
}
