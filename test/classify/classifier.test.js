import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl } from '../../src/classify/classifier.js';
import { extractGameCandidate, normalizeGameName } from '../../src/classify/game-name.js';
import { matchNonGame } from '../../src/classify/non-game.js';
import { extractPageMeta, matchMeta } from '../../src/classify/page-meta.js';

function rec(url, extra = {}) {
  return { originalUrl: url, normalizedUrl: url, urlHash: 'h', siteId: 's', domain: 'd', sitemapUrl: null, ...extra };
}

test('测试1 明确游戏 URL + 页面标题交叉确认 → game/high', () => {
  const meta = extractPageMeta('<html><head><title>Subway Surfers - Play Online</title></head><h1>Subway Surfers</h1></html>');
  const r = classifyUrl(rec('https://poki.com/en/g/subway-surfers'), {
    expectedGamePath: '/g/',
    page: { ok: true, meta },
  });
  assert.equal(r.pageType, 'game');
  assert.equal(r.confidence, 'high');
  assert.equal(r.gameName, 'subway-surfers');
  assert.ok(r.evidence.length >= 2, '至少两个独立证据');
});

test('测试2 明确分类 URL → non_game', () => {
  assert.equal(classifyUrl(rec('https://x.com/category/action')).pageType, 'non_game');
  assert.equal(classifyUrl(rec('https://x.com/tag/puzzle')).pageType, 'non_game');
  assert.equal(classifyUrl(rec('https://x.com/assets/app.js')).pageType, 'non_game');
  assert.equal(classifyUrl(rec('https://x.com/sitemap.xml')).pageType, 'non_game');
  assert.equal(classifyUrl(rec('https://x.com/action-games')).pageType, 'non_game');
});

test('测试3 只有一个证据（expected_game_path 命中，无页面交叉确认）→ game/medium', () => {
  const r = classifyUrl(rec('https://poki.com/en/g/some-new-game'), { expectedGamePath: '/g/' });
  assert.equal(r.pageType, 'game');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.gameName, 'some-new-game');
});

test('测试4 只有 slug（通用兜底，无平台规则、无页面）→ game/low', () => {
  const r = classifyUrl(rec('https://unknown-site.test/cool-adventure'));
  assert.equal(r.pageType, 'game');
  assert.equal(r.confidence, 'low');
  assert.equal(r.gameName, 'cool-adventure');
  assert.ok(r.evidence.some((e) => /generic|单段|通用/.test(e)));
});

test('测试5 页面请求失败 → unknown/low + classificationError，URL 仍保留候选', () => {
  const r = classifyUrl(rec('https://poki.com/en/g/broken-page'), {
    expectedGamePath: '/g/',
    page: { ok: false, errorCode: 'TIMEOUT' },
  });
  assert.equal(r.pageType, 'unknown');
  assert.equal(r.confidence, 'low');
  assert.equal(r.classificationError, 'TIMEOUT');
  assert.ok(r.evidence.includes('page_fetch_failed'));
  assert.equal(r.gameName, 'broken-page', '抓取失败也应保留 URL 里的候选名');
});

test('测试6 无法提取游戏名（深层非游戏路径）→ unknown，但不丢弃', () => {
  const r = classifyUrl(rec('https://x.com/foo/bar/baz'));
  assert.equal(r.pageType, 'unknown');
  assert.equal(r.confidence, 'low');
  assert.ok(r.evidence.includes('insufficient_evidence'));
});

test('JSON-LD 明确表示游戏 → game（即使 URL 没有明显 slug 规则也给 medium）', () => {
  const meta = extractPageMeta(
    '<html><head><title>Fun</title><script type="application/ld+json">{"@type":"VideoGame","name":"Neon Drift"}</script></head></html>',
  );
  const r = classifyUrl(rec('https://x.com/foo/bar/baz'), { page: { ok: true, meta } });
  assert.equal(r.pageType, 'game');
  assert.equal(r.confidence, 'medium');
  assert.ok(r.evidence.includes('jsonld_game'));
});

test('平台规则命中但无交叉确认 → game/medium', () => {
  const r = classifyUrl(rec('https://poki.com/en/g/tower-defense'));
  assert.equal(r.pageType, 'game');
  assert.equal(r.confidence, 'medium');
});

test('normalizeGameName 保留中文', () => {
  assert.equal(normalizeGameName('超级 玛丽 Mario'), '超级-玛丽-mario');
});

test('extractGameCandidate：expected_path 优先于通用规则，source 正确', () => {
  const c = extractGameCandidate('https://site.com/play/foo-bar', '/play/');
  assert.equal(c.source, 'expected_path');
  assert.equal(c.cleanName, 'foo-bar');
});

test('matchNonGame：静态资源扩展名与非游戏片段', () => {
  assert.equal(matchNonGame('https://x.com/style.css').matched, true);
  assert.equal(matchNonGame('https://x.com/login').matched, true);
  assert.equal(matchNonGame('https://x.com/g/real-game').matched, false);
});

test('matchMeta：JSON-LD 与标题命中 slug', () => {
  const meta = extractPageMeta('<title>Space Runner Game</title>');
  const ev = matchMeta(meta, { cleanName: 'space-runner' });
  assert.ok(ev.includes('title_matches_slug'));
});
