/**
 * 游戏名称候选提取。
 *
 * 规则移植自 legacy/v2-cloud-supabase/lib/rss-manager.js 的 extractGameName() /
 * normalizeGameName()（含各平台专用路径规则），但有两处关键改动：
 *   1. 不再在"无法识别"时 return null → continue → 丢弃 URL；本模块只负责
 *      "能不能从 URL 提取到一个游戏名候选"，识别不出返回 null 交给分类器，
 *      分类器会把它保留为 unknown（URL 绝不丢失）。
 *   2. 返回结果带 source（证据来源），便于分类器计算置信度：
 *        'expected_path'  —— 命中 config 里该站的 expected_game_path
 *        'platform_rule'  —— 命中某个已知平台的专用路径规则
 *        'generic_slug'   —— 只命中通用 /game|/g|/play|.html|单段路径 兜底规则
 */

export function normalizeGameName(name) {
  return name
    .toLowerCase()
    .replace(/[-_\s]+/g, '-')
    .replace(/[^a-z0-9一-鿿-]/g, '') // 保留中文，去掉其他非法字符
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * 从 URL 提取游戏名候选。
 * @returns { name, cleanName, source, evidence: string[] } | null
 */
export function extractGameCandidate(url, expectedGamePath) {
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch {
    return null;
  }
  const hostname = urlObj.hostname;
  const pathname = urlObj.pathname;

  // 0) 优先使用 config 里配置的 expected_game_path（站点级最强路径证据）。
  if (expectedGamePath) {
    const seg = escapeRegExp(expectedGamePath.replace(/^\/+|\/+$/g, ''));
    if (seg) {
      const re = new RegExp(`/${seg}/([^/?]+)/?$`, 'i');
      const m = pathname.match(re);
      if (m) {
        return finalize(m[1], 'expected_path', `expected_game_path 命中: ${expectedGamePath} → ${m[1]}`);
      }
    }
  }

  // 1) 已知平台专用规则。
  const platform = extractByPlatform(hostname, pathname);
  if (platform) {
    return finalize(platform.name, 'platform_rule', `平台规则命中(${platform.rule}): ${platform.name}`);
  }

  // 2) 通用规则兜底。
  const generic = extractGeneric(pathname);
  if (generic) {
    return finalize(generic.name, 'generic_slug', `通用规则命中(${generic.rule}): ${generic.name}`);
  }

  return null;
}

function finalize(rawName, source, evidence) {
  if (!rawName) return null;
  const trimmed = rawName.replace(/\.html?$/i, '');
  if (trimmed.length < 2 || trimmed.length > 100) return null;
  const cleanName = normalizeGameName(trimmed);
  if (!cleanName || cleanName.length < 2) return null;
  return { name: trimmed, cleanName, source, evidence: [evidence] };
}

function extractByPlatform(hostname, pathname) {
  if (hostname.includes('poki.com')) {
    const m = pathname.match(/\/g\/([^/?]+)$/);
    if (m) return { name: m[1], rule: 'poki /g/<slug>' };
  } else if (hostname.includes('coolmathgames.com')) {
    const m = pathname.match(/\/(\d+-[^/?]+)$/);
    if (m) return { name: m[1].replace(/^\d+-/, ''), rule: 'coolmath /<id>-<slug>' };
  } else if (hostname.includes('itch.io')) {
    if (hostname !== 'itch.io') {
      const m = pathname.match(/^\/([^/?]+)$/);
      if (m && !['jam', 'jams', 'games', 'tools', 'assets'].includes(m[1])) {
        return { name: m[1], rule: 'itch.io <sub>/<slug>' };
      }
    }
  } else if (hostname.includes('kongregate.com')) {
    const m = pathname.match(/\/games\/[^/]+\/([^/?]+)$/);
    if (m) return { name: m[1], rule: 'kongregate /games/<user>/<slug>' };
  } else if (hostname.includes('armorgames.com')) {
    const m = pathname.match(/\/(?:game|play)\/([^/?]+)$/);
    if (m) return { name: m[1], rule: 'armorgames /game|play/<slug>' };
  } else if (hostname.includes('newgrounds.com')) {
    const m = pathname.match(/\/portal\/view\/(\d+)$/);
    if (m) return { name: `newgrounds-${m[1]}`, rule: 'newgrounds /portal/view/<id>' };
  } else if (hostname.includes('miniclip.com')) {
    const m = pathname.match(/\/games\/([^/?]+)$/);
    if (m && m[1] !== 'genre') return { name: m[1], rule: 'miniclip /games/<slug>' };
  } else if (hostname.includes('y8.com')) {
    const m = pathname.match(/\/games\/([^/?]+)$/);
    if (m) return { name: m[1], rule: 'y8 /games/<slug>' };
  } else if (hostname.includes('friv.com')) {
    const m = pathname.match(/\/(?:game|play)\/([^/?]+)$/);
    if (m) return { name: m[1], rule: 'friv /game|play/<slug>' };
  }
  return null;
}

function extractGeneric(pathname) {
  const patterns = [
    { re: /\/(?:games?|play|g)\/([^/?]+)$/i, rule: '/games|game|play|g/<slug>' },
    { re: /\/([^/?]+)-game$/i, rule: '/<slug>-game' },
    { re: /\/([^/?]+)\.html?$/i, rule: '/<slug>.html' },
  ];
  for (const p of patterns) {
    const m = pathname.match(p.re);
    if (m) return { name: m[1].replace(/\.html?$/i, ''), rule: p.rule };
  }
  // 单段路径兜底：/single-slug（最弱的 generic 证据）
  const single = pathname.match(/^\/([^/?]+)$/);
  if (single) return { name: single[1], rule: '/<single-slug>' };
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
