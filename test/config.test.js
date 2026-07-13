import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLocalConfig, parseSitesCsv } from '../src/config.js';

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
