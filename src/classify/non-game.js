/**
 * 非游戏页面判定：静态资源、分类/标签/搜索/博客/新闻/隐私/联系/登录/Sitemap
 * 等明确的非游戏页面。命中即可仅凭 URL 判定为 non_game，无需抓取页面。
 *
 * 分类关键词与排除规则移植自 legacy/v2-cloud-supabase/lib/rss-manager.js。
 */

const STATIC_EXT_RE = /\.(xml|json|txt|css|js|mjs|png|jpe?g|gif|ico|svg|webp|avif|woff2?|ttf|eot|mp4|webm|mp3|wav|pdf|zip|gz)$/i;

const NON_GAME_SEGMENT_RE =
  /\/(tag|tags|category|categories|genre|genres|author|users?|profile|about|about-us|contact|contact-us|privacy|privacy-policy|terms|terms-of-service|tos|faq|help|support|search|browse|login|signin|sign-in|register|signup|sign-up|account|blog|news|press|careers|jobs|advertise|sitemap|sitemaps|feed|rss|atom|robots)(\/|$)/i;

// 作为最后一段路径出现时，视为分类/导航页而非单个游戏。
const CATEGORY_KEYWORDS = new Set([
  'games', 'all-games', 'new-games', 'hot-games', 'popular-games', 'trending-games',
  'top-games', 'featured-games', 'best-games', 'free-games', 'all-tags', 'top-popular',
  'action-games', 'adventure-games', 'puzzle-games', 'racing-games', 'sports-games',
  'strategy-games', 'shooting-games', 'arcade-games', 'casual-games', 'multiplayer-games',
  'io-games', 'html5-games', 'girl-games', 'boy-games', 'kids-games', 'girls-games',
  'boys-games', '2-player-games', 'multiplayer', 'single-player',
  'about', 'contact', 'privacy', 'terms', 'faq', 'help', 'support', 'blog', 'news',
  'press', 'careers', 'jobs', 'advertise', 'category', 'categories', 'tag', 'tags',
  'genre', 'genres', 'online', 'offline', 'download', 'downloads', 'login', 'register',
  'signup', 'signin', 'search', 'browse', 'index', 'home', 'recents', 'updated',
  'terms-of-service', 'privacy-policy', 'contact-us', 'about-us',
]);

// 少数"看着像分类但其实是知名游戏"的白名单，避免误杀。
// 注意：只用复数 -games 作为分类启发式；单数 -game（如 real-game、card-game）
// 常是真实游戏名，交给游戏名提取器处理，不在这里判为分类。
const VALID_GAME_ENDINGS = [/hunger-games$/, /squid-games$/, /mario-games$/, /pokemon-games$/, /sonic-games$/];

/**
 * @returns { matched: boolean, kind: string|null, evidence: string[] }
 */
export function matchNonGame(url) {
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch {
    return { matched: false, kind: null, evidence: [] };
  }
  const pathname = urlObj.pathname;

  if (STATIC_EXT_RE.test(pathname)) {
    const ext = pathname.match(STATIC_EXT_RE)[0];
    return { matched: true, kind: 'static_resource', evidence: [`静态资源扩展名: ${ext}`] };
  }

  const seg = pathname.match(NON_GAME_SEGMENT_RE);
  if (seg) {
    return { matched: true, kind: 'non_game_path', evidence: [`非游戏路径片段: ${seg[1]}`] };
  }

  // 首页 / 语言首页
  if (/^\/$/.test(pathname)) {
    return { matched: true, kind: 'homepage', evidence: ['首页 /'] };
  }
  if (/^\/[a-z]{2}(-[a-z]{2})?\/?$/i.test(pathname)) {
    return { matched: true, kind: 'homepage', evidence: [`语言首页: ${pathname}`] };
  }

  // 末段是分类关键词
  const lastSeg = decodeSafe((pathname.split('/').filter(Boolean).pop() || '').toLowerCase());
  if (lastSeg) {
    if (CATEGORY_KEYWORDS.has(lastSeg)) {
      return { matched: true, kind: 'category', evidence: [`分类关键词: ${lastSeg}`] };
    }
    if (/-games$/.test(lastSeg) && !VALID_GAME_ENDINGS.some((re) => re.test(lastSeg))) {
      return { matched: true, kind: 'category', evidence: [`疑似分类页(以 -games 结尾): ${lastSeg}`] };
    }
  }

  return { matched: false, kind: null, evidence: [] };
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
