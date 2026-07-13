import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSitesCsv } from '../src/config.js';

/**
 * Milestone 5 阶段 0：正式站点清单 config/sites.csv 的数据质量检查。
 * 这些是"能不能开始规模验证"的准入检查，不是站点内容本身的正确性检查
 * （站点内容正确性要靠 --inspect-site / 正式采集结果逐个确认，属于阶段 2 以后的事）。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const sitesCsvPath = resolve(__dirname, '..', 'config', 'sites.csv');

function loadRealSites() {
  const text = readFileSync(sitesCsvPath, 'utf-8');
  return parseSitesCsv(text);
}

test('config/sites.csv 可以被解析，且不是空文件', () => {
  const records = loadRealSites();
  assert.ok(records.length > 0, 'config/sites.csv 不应该是空的');
});

test('config/sites.csv：site_id 全部唯一', () => {
  const records = loadRealSites();
  const ids = records.map((r) => r.site_id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `存在重复 site_id: ${findDuplicates(ids).join(', ')}`);
});

test('config/sites.csv：domain 全部唯一', () => {
  const records = loadRealSites();
  const domains = records.map((r) => r.domain);
  const unique = new Set(domains);
  assert.equal(unique.size, domains.length, `存在重复 domain: ${findDuplicates(domains).join(', ')}`);
});

test('config/sites.csv：enabled 字段的值都在合法取值范围内', () => {
  const records = loadRealSites();
  const invalid = records.filter((r) => !/^(true|false|1|0)$/i.test(r.enabled));
  assert.deepEqual(
    invalid.map((r) => `${r.site_id}=${JSON.stringify(r.enabled)}`),
    [],
    'enabled 只接受 true/false/1/0（大小写不敏感），否则会被 syncSites 静默当成禁用',
  );
});

test('config/sites.csv：没有空 domain 或空 site_id', () => {
  const records = loadRealSites();
  const badDomain = records.filter((r) => !r.domain);
  const badId = records.filter((r) => !r.site_id);
  assert.deepEqual(badDomain.map((r) => r.site_id), [], '存在空 domain 的行');
  assert.deepEqual(badId.map((r) => r.domain), [], '存在空 site_id 的行');
});

function findDuplicates(values) {
  const seen = new Set();
  const dups = new Set();
  for (const v of values) {
    if (seen.has(v)) dups.add(v);
    seen.add(v);
  }
  return [...dups];
}
