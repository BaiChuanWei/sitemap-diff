import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, urlHash, toUrlRecord } from '../../src/storage/normalize.js';

test('trim 前后空白', () => {
  assert.equal(normalizeUrl('  https://x.com/g/a  '), 'https://x.com/g/a');
});

test('协议与主机名小写', () => {
  assert.equal(normalizeUrl('HTTPS://EXAMPLE.COM/Path'), 'https://example.com/Path');
});

test('删除 fragment', () => {
  assert.equal(normalizeUrl('https://x.com/g/a#section'), 'https://x.com/g/a');
});

test('默认端口归一化（443/80 去掉）', () => {
  assert.equal(normalizeUrl('https://x.com:443/a'), 'https://x.com/a');
  assert.equal(normalizeUrl('http://x.com:80/a'), 'http://x.com/a');
});

test('非默认端口保留', () => {
  assert.equal(normalizeUrl('https://x.com:8443/a'), 'https://x.com:8443/a');
});

test('保留路径大小写', () => {
  assert.equal(normalizeUrl('https://x.com/Game/CamelCase'), 'https://x.com/Game/CamelCase');
});

test('保留查询参数，不删除 tracking 参数', () => {
  assert.equal(normalizeUrl('https://x.com/g/a?utm_source=x&ref=y'), 'https://x.com/g/a?utm_source=x&ref=y');
});

test('不合并不同尾部路径：/a 与 /a/ 不同', () => {
  assert.notEqual(normalizeUrl('https://x.com/g/a'), normalizeUrl('https://x.com/g/a/'));
});

test('非 http(s) URL 抛错', () => {
  assert.throws(() => normalizeUrl('ftp://x.com/a'));
  assert.throws(() => normalizeUrl('not a url'));
});

test('urlHash：相同 normalized URL → 相同哈希；不同 → 不同', () => {
  const h1 = urlHash(normalizeUrl('  https://x.com/g/a  '));
  const h2 = urlHash(normalizeUrl('https://x.com/g/a'));
  const h3 = urlHash(normalizeUrl('https://x.com/g/b'));
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('toUrlRecord：返回 original/normalized/hash；非法 URL 返回 null', () => {
  const rec = toUrlRecord('  https://X.com/g/a#f  ');
  assert.equal(rec.originalUrl, 'https://X.com/g/a#f');
  assert.equal(rec.normalizedUrl, 'https://x.com/g/a');
  assert.match(rec.urlHash, /^[0-9a-f]{64}$/);
  assert.equal(toUrlRecord('nonsense'), null);
});
