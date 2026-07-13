import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

const expectedFixtures = [
  'urlset-old.xml',
  'urlset-new.xml',
  'sitemap-index.xml',
  'nested-sitemap-index.xml',
  'child-games-1.xml',
  'child-games-2.xml',
  'sitemap.xml.gz',
  'empty.xml',
  'truncated.xml',
  'html-instead-of-xml.html',
  'circular-index-a.xml',
  'circular-index-b.xml',
  'duplicate-urls.xml',
  'large-drop-old.xml',
  'large-drop-new.xml',
];

test('fixture baseline: 所有约定的 fixture 文件都存在且非空', () => {
  for (const name of expectedFixtures) {
    const stat = statSync(join(fixturesDir, name));
    assert.ok(stat.size > 0, `${name} 不应为空文件`);
  }
});

test('fixture 基本形状: 普通 urlset 含 <urlset> 和至少一个 <loc>', () => {
  const content = readFileSync(join(fixturesDir, 'urlset-old.xml'), 'utf-8');
  assert.match(content, /<urlset[\s>]/);
  assert.match(content, /<loc>/);
});

test('fixture 基本形状: sitemap-index 含 <sitemapindex> 而不是 <urlset>', () => {
  const content = readFileSync(join(fixturesDir, 'sitemap-index.xml'), 'utf-8');
  assert.match(content, /<sitemapindex[\s>]/);
  assert.doesNotMatch(content, /<urlset[\s>]/);
});

test('fixture 基本形状: nested-sitemap-index 指向另一个 index', () => {
  const content = readFileSync(join(fixturesDir, 'nested-sitemap-index.xml'), 'utf-8');
  assert.match(content, /sitemap-index\.xml/);
});

test('fixture 基本形状: empty.xml 是合法 urlset 但零个 <loc>', () => {
  const content = readFileSync(join(fixturesDir, 'empty.xml'), 'utf-8');
  assert.match(content, /<urlset[\s>]/);
  assert.doesNotMatch(content, /<loc>/);
});

test('fixture 基本形状: truncated.xml 缺少闭合标签', () => {
  const content = readFileSync(join(fixturesDir, 'truncated.xml'), 'utf-8');
  assert.doesNotMatch(content, /<\/urlset>/);
});

test('fixture 基本形状: html-instead-of-xml.html 不是 XML', () => {
  const content = readFileSync(join(fixturesDir, 'html-instead-of-xml.html'), 'utf-8');
  assert.match(content, /<!DOCTYPE html>/i);
  assert.doesNotMatch(content, /<urlset/);
});

test('fixture 基本形状: circular-index-a/b 互相指向对方', () => {
  const a = readFileSync(join(fixturesDir, 'circular-index-a.xml'), 'utf-8');
  const b = readFileSync(join(fixturesDir, 'circular-index-b.xml'), 'utf-8');
  assert.match(a, /circular-index-b\.xml/);
  assert.match(b, /circular-index-a\.xml/);
});

test('fixture 基本形状: duplicate-urls.xml 含重复的 <loc>', () => {
  const content = readFileSync(join(fixturesDir, 'duplicate-urls.xml'), 'utf-8');
  const matches = content.match(/<loc>https:\/\/example-games\.test\/g\/space-runner<\/loc>/g);
  assert.equal(matches.length, 2);
});

test('fixture 基本形状: large-drop 从 20 个 URL 降到 2 个（>90% 骤降）', () => {
  const oldContent = readFileSync(join(fixturesDir, 'large-drop-old.xml'), 'utf-8');
  const newContent = readFileSync(join(fixturesDir, 'large-drop-new.xml'), 'utf-8');
  const oldCount = (oldContent.match(/<loc>/g) || []).length;
  const newCount = (newContent.match(/<loc>/g) || []).length;
  assert.equal(oldCount, 20);
  assert.equal(newCount, 2);
  assert.ok(newCount < oldCount * 0.5, '应该是超过 50%（实际测的是 >90%）的骤降场景');
});

test('fixture 基本形状: sitemap.xml.gz 是真实 gzip 文件（魔数 0x1f 0x8b）', () => {
  const buffer = readFileSync(join(fixturesDir, 'sitemap.xml.gz'));
  assert.equal(buffer[0], 0x1f);
  assert.equal(buffer[1], 0x8b);
});
