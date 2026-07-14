import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig, parseSitesCsv, loadSiteOverrides, parseCsvWithHeaders, serializeCsv } from '../src/config.js';

test('loadLocalConfig: 默认路径都在项目内，且可以被 overrides 覆盖', () => {
  const defaults = loadLocalConfig();
  assert.match(defaults.dbPath, /data[/\\]local\.db$/);
  assert.match(defaults.sitesCsvPath, /config[/\\]sites\.csv$/);
  assert.doesNotMatch(defaults.sitesCsvPath, /sites\.example\.csv$/, '默认清单不能是示例文件');
  assert.match(defaults.outputDir, /output$/);

  const overridden = loadLocalConfig({ dbPath: '/tmp/x.db' });
  assert.equal(overridden.dbPath, '/tmp/x.db');
});

test('parseSitesCsv: 解析标准字段', () => {
  const csv = [
    'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes',
    'poki,poki.com,high,true,https://poki.com/robots.txt,,/g/,示例站点',
  ].join('\n');

  const records = parseSitesCsv(csv);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    site_id: 'poki',
    domain: 'poki.com',
    priority: 'high',
    enabled: 'true',
    robots_url: 'https://poki.com/robots.txt',
    sitemap_url: '',
    expected_game_path: '/g/',
    notes: '示例站点',
  });
});

test('parseSitesCsv: 支持双引号包裹、内含英文逗号的字段', () => {
  const csv = [
    'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes',
    'x,x.com,low,false,,,,"note with, a comma"',
  ].join('\n');

  const records = parseSitesCsv(csv);
  assert.equal(records[0].notes, 'note with, a comma');
});

test('parseSitesCsv: 空文本返回空数组', () => {
  assert.deepEqual(parseSitesCsv(''), []);
});

test('parseSitesCsv: 忽略空行', () => {
  const csv = [
    'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes',
    'a,a.com,high,true,,,,',
    '',
    'b,b.com,low,false,,,,',
  ].join('\n');

  const records = parseSitesCsv(csv);
  assert.equal(records.length, 2);
});

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'm5a-config-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadSiteOverrides: 两份覆盖文件都不存在时返回空 Map，不报错', () => {
  withTempDir((dir) => {
    const config = loadLocalConfig({
      siteLimitsCsvPath: join(dir, 'nope-limits.csv'),
      siteSitemapsCsvPath: join(dir, 'nope-sitemaps.csv'),
    });
    const { limitOverrides, sitemapOverrides } = loadSiteOverrides(config);
    assert.equal(limitOverrides.size, 0);
    assert.equal(sitemapOverrides.size, 0);
  });
});

test('loadSiteOverrides: 文件存在时正确解析真实内容', () => {
  withTempDir((dir) => {
    const limitsPath = join(dir, 'site-limits.csv');
    const sitemapsPath = join(dir, 'site-sitemaps.csv');
    writeFileSync(
      limitsPath,
      'site_id,max_download_bytes,max_decompressed_bytes,max_page_urls,max_sitemap_endpoints,max_depth,request_timeout_ms\nkongregate,52428800,,,,,\n',
      'utf-8',
    );
    writeFileSync(
      sitemapsPath,
      'site_id,sitemap_url,enabled,mode,notes,verified_at\nlagged,https://lagged.com/sitemap.xml,true,manual_only,test,2026-07-14\n',
      'utf-8',
    );
    const config = loadLocalConfig({ siteLimitsCsvPath: limitsPath, siteSitemapsCsvPath: sitemapsPath });
    const { limitOverrides, sitemapOverrides } = loadSiteOverrides(config);
    assert.equal(limitOverrides.get('kongregate').MAX_DOWNLOAD_BYTES, 52428800);
    assert.deepEqual(sitemapOverrides.get('lagged'), { mode: 'manual_only', urls: ['https://lagged.com/sitemap.xml'] });
  });
});

test('parseCsvWithHeaders + serializeCsv：往返一致，含逗号/引号/中文/空值', () => {
  const original = [
    'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes,site_category',
    'poki,poki.com,high,true,https://poki.com/robots.txt,,/g/,"备注，含逗号和""引号""",A',
    'x,x.com,low,false,,,,',
  ].join('\n');
  const { headers, rows } = parseCsvWithHeaders(original);
  const serialized = serializeCsv(headers, rows);
  const reparsed = parseCsvWithHeaders(serialized);
  assert.deepEqual(reparsed.headers, headers);
  assert.deepEqual(reparsed.rows, rows);
  assert.equal(rows[0].notes, '备注，含逗号和"引号"');
});

test('serializeCsv：换行符字段正确转义', () => {
  const headers = ['site_id', 'notes'];
  const rows = [{ site_id: 'a', notes: 'line1\nline2' }];
  const serialized = serializeCsv(headers, rows);
  const reparsed = parseCsvWithHeaders(serialized);
  assert.equal(reparsed.rows[0].notes, 'line1\nline2');
});

test('loadSiteOverrides: 文件存在但内容非法时明确抛错，不静默使用危险值', () => {
  withTempDir((dir) => {
    const limitsPath = join(dir, 'site-limits.csv');
    writeFileSync(limitsPath, 'site_id,max_download_bytes\nx,not-a-number\n', 'utf-8');
    const config = loadLocalConfig({ siteLimitsCsvPath: limitsPath, siteSitemapsCsvPath: join(dir, 'nope.csv') });
    assert.throws(() => loadSiteOverrides(config), /不是合法正整数/);
  });
});
