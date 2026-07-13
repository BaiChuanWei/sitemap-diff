import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSitemapXml } from '../../src/sitemap/parser.js';
import { SitemapParseError, PARSE_ERROR_CODES } from '../../src/sitemap/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

function fixture(name) {
  return readFileSync(join(fixturesDir, name), 'utf-8');
}

test('普通 urlset：提取全部 <loc>', () => {
  const result = parseSitemapXml(fixture('urlset-basic.xml'));
  assert.equal(result.type, 'urlset');
  assert.deepEqual(result.locations, [
    'https://example-games.test/g/tower-siege',
    'https://example-games.test/g/moto-jump-arena',
  ]);
  assert.deepEqual(result.warnings, []);
});

test('XML 命名空间：带前缀的 s:url/s:loc 正常解析，image:loc 不会混入页面 URL', () => {
  const result = parseSitemapXml(fixture('urlset-namespace.xml'));
  assert.equal(result.type, 'urlset');
  assert.equal(result.locations.length, 2);
  assert.ok(!result.locations.some((u) => u.includes('pixel-knight-cover.jpg')), 'image:loc 不应出现在页面 URL 列表中');
});

test('XML 实体：&amp; 会被正确解码', () => {
  const result = parseSitemapXml(fixture('urlset-namespace.xml'));
  assert.ok(
    result.locations.includes('https://example-games.test/g/pixel-knight?level=1&mode=story'),
    '&amp; 应该被解码为 &',
  );
});

test('CDATA：<![CDATA[...]]> 包裹的 URL 正常解析', () => {
  const result = parseSitemapXml(fixture('urlset-cdata.xml'));
  assert.equal(result.type, 'urlset');
  assert.deepEqual(result.locations, [
    'https://example-games.test/g/cdata-crossword',
    'https://example-games.test/g/cdata-battle-royale',
  ]);
});

test('Sitemap Index：根元素是 sitemapindex，locations 是子 Sitemap URL 而不是页面 URL', () => {
  const result = parseSitemapXml(fixture('sitemap-index.xml'));
  assert.equal(result.type, 'sitemapindex');
  assert.deepEqual(result.locations, [
    'https://example-games.test/child-games-1.xml',
    'https://example-games.test/child-games-2.xml',
  ]);
});

test('未知根元素：html 会明确报错而不是被当成 sitemap 静默处理', () => {
  assert.throws(
    () => parseSitemapXml(fixture('html-instead-of-xml.html')),
    (err) => {
      assert.ok(err instanceof SitemapParseError);
      assert.equal(err.code, PARSE_ERROR_CODES.UNKNOWN_ROOT);
      return true;
    },
  );
});

test('空 XML：合法 urlset 但零个 <loc>，不产生假 URL', () => {
  const result = parseSitemapXml(fixture('empty.xml'));
  assert.equal(result.type, 'urlset');
  assert.deepEqual(result.locations, []);
});

test('截断 XML：缺少闭合标签必须报错为 INVALID_XML', () => {
  assert.throws(
    () => parseSitemapXml(fixture('truncated.xml')),
    (err) => {
      assert.ok(err instanceof SitemapParseError);
      assert.equal(err.code, PARSE_ERROR_CODES.INVALID_XML);
      return true;
    },
  );
});

test('完全非 XML 内容（随机文本）报错为 INVALID_XML', () => {
  assert.throws(() => parseSitemapXml('not xml at all { just text'), SitemapParseError);
});

test('URL 去重：同一份 XML 内重复的 <loc> 只保留一次', () => {
  const result = parseSitemapXml(fixture('duplicate-urls.xml'));
  assert.equal(result.type, 'urlset');
  const spaceRunnerCount = result.locations.filter((u) => u === 'https://example-games.test/g/space-runner').length;
  assert.equal(spaceRunnerCount, 1);
  assert.equal(result.locations.length, 2);
});

test('嵌套 Sitemap Index：本身也是合法的 sitemapindex，递归留给 recursive-loader', () => {
  const result = parseSitemapXml(fixture('nested-sitemap-index.xml'));
  assert.equal(result.type, 'sitemapindex');
  assert.deepEqual(result.locations, ['https://example-games.test/sitemap-index.xml']);
});
