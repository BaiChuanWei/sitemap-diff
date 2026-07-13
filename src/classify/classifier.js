import { matchNonGame } from './non-game.js';
import { extractGameCandidate } from './game-name.js';
import { matchMeta } from './page-meta.js';

/**
 * 对单个 URL 做可解释的页面分类。核心原则：
 *   - 所有 URL 都会得到一个结果，识别不出 → unknown（绝不丢弃）；
 *   - 每个结果都带 evidence；
 *   - 页面抓取失败 → unknown / low / classificationError，但保留 URL 和 slug 候选。
 *
 * @param record { originalUrl, normalizedUrl, urlHash, siteId, domain, sitemapUrl }
 * @param opts   { expectedGamePath?, page? }
 *   page 三态：
 *     - undefined/null：未抓取页面（仅按 URL 判定）
 *     - { ok: true, meta }：抓取成功，meta 为 extractPageMeta 结果
 *     - { ok: false, errorCode }：抓取失败
 * @returns {
 *   pageType: 'game'|'non_game'|'unknown',
 *   gameName: string|null,
 *   confidence: 'high'|'medium'|'low',
 *   evidence: string[],
 *   classificationError: string|null
 * }
 */
export function classifyUrl(record, opts = {}) {
  const url = record.normalizedUrl || record.originalUrl;
  const { expectedGamePath, page } = opts;

  // 1) 明确的非游戏页面：仅凭 URL 判定，无需页面。
  const nonGame = matchNonGame(url);
  if (nonGame.matched) {
    return result('non_game', null, 'high', nonGame.evidence, null);
  }

  // 2) 从 URL 提取游戏名候选。
  const candidate = extractGameCandidate(url, expectedGamePath);

  // 3) 页面抓取失败：无法交叉确认 → unknown/low，但保留候选名与 URL。
  if (page && page.ok === false) {
    const evidence = [...(candidate ? candidate.evidence : []), 'page_fetch_failed'];
    return result('unknown', candidate ? candidate.cleanName : null, 'low', evidence, page.errorCode || 'PAGE_FETCH_FAILED');
  }

  const meta = page && page.ok ? page.meta : null;
  const metaEvidence = meta ? matchMeta(meta, candidate) : [];
  const hasMetaConfirm = metaEvidence.some((e) => e.endsWith('_matches_slug'));
  const jsonldGame = metaEvidence.includes('jsonld_game');

  // 4) 有游戏名候选 → game，置信度按证据强度。
  if (candidate) {
    const strong = candidate.source === 'expected_path' || candidate.source === 'platform_rule';
    const evidence = [...candidate.evidence, ...metaEvidence];
    let confidence;
    if (strong && (hasMetaConfirm || jsonldGame)) {
      confidence = 'high'; // 强路径规则 + 页面交叉确认：两个独立证据
    } else if (strong || jsonldGame) {
      confidence = 'medium'; // 单个较强证据，缺交叉确认
    } else if (hasMetaConfirm) {
      confidence = 'medium'; // 弱 slug + 标题命中
    } else {
      confidence = 'low'; // 只根据 slug 推测
    }
    return result('game', candidate.cleanName, confidence, evidence, null);
  }

  // 5) 无候选，但页面 JSON-LD 明确表示是游戏/软件 → game/medium。
  if (jsonldGame) {
    const name = metaGameName(meta);
    return result('game', name, 'medium', ['jsonld_game'], null);
  }

  // 6) 证据不足 → unknown（URL 仍保留导出）。
  return result('unknown', null, 'low', ['insufficient_evidence'], null);
}

function metaGameName(meta) {
  const raw = (meta && (meta.h1 || meta.title || meta.ogTitle)) || null;
  if (!raw) return null;
  return raw.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

function result(pageType, gameName, confidence, evidence, classificationError) {
  return { pageType, gameName: gameName || null, confidence, evidence, classificationError };
}
