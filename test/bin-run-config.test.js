import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from '../src/config.js';
import { loadRecords } from '../bin/run.js';

/**
 * --inspect-site 和 --collect 内部都是：
 *   const config = loadLocalConfig();      // 不传 overrides，走默认值
 *   const records = loadRecords(config);   // 直接用 config.sitesCsvPath 读文件
 * 两个命令之间没有任何分支逻辑区分彼此的清单来源——它们调用的是完全相同的
 * 两行代码。所以只要证明这两行代码本身的默认行为、覆盖行为、缺文件行为正确，
 * 就等于证明了两个命令的行为正确，不需要分别起两个真实子进程重复验证。
 */

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bin-run-config-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('默认配置：sitesCsvPath 指向正式的 config/sites.csv，不是 sites.example.csv', () => {
  const config = loadLocalConfig();
  assert.match(config.sitesCsvPath, /config[/\\]sites\.csv$/);
  assert.doesNotMatch(config.sitesCsvPath, /sites\.example\.csv$/);
});

test('--inspect-site / --collect 共用的 loadRecords(loadLocalConfig()) 默认读取真实的 config/sites.csv', () => {
  const config = loadLocalConfig(); // 不传 overrides，等价于 CLI 命令内部的调用方式
  const records = loadRecords(config);
  assert.ok(records, '真实 config/sites.csv 应该能被正常解析');
  assert.ok(records.length > 50, '正式清单应该有几十上百条，而不是示例文件的 3 条');
  // crazygames.org 对应的 site_id 只存在于正式清单里，示例文件里没有，
  // 命中它就证明确实读的是 config/sites.csv 而不是 sites.example.csv。
  assert.ok(
    records.some((r) => r.site_id === 'crazygames_2' && r.domain === 'crazygames.org'),
    '应该能在默认清单里找到只存在于 config/sites.csv 的站点',
  );
});

test('显式指定测试配置时仍能覆盖默认路径（loadLocalConfig({ sitesCsvPath }) 优先于默认值）', () => {
  withTempDir((dir) => {
    const csvPath = join(dir, 'custom-sites.csv');
    writeFileSync(
      csvPath,
      ['site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes', 'only-in-override,override.test,high,true,,,,'].join('\n'),
      'utf-8',
    );

    const config = loadLocalConfig({ sitesCsvPath: csvPath });
    assert.equal(config.sitesCsvPath, csvPath, '显式 override 应该原样生效，不被默认值覆盖');

    const records = loadRecords(config);
    assert.equal(records.length, 1);
    assert.equal(records[0].site_id, 'only-in-override');
  });
});

test('sitesCsvPath 指向不存在的文件：loadRecords 返回 null 并给出包含路径和创建提示的错误', () => {
  withTempDir((dir) => {
    const missingPath = join(dir, 'does-not-exist.csv');
    const config = loadLocalConfig({ sitesCsvPath: missingPath });

    const originalError = console.error;
    const originalExitCode = process.exitCode;
    const logs = [];
    console.error = (...args) => logs.push(args.join(' '));
    let records;
    try {
      records = loadRecords(config);
    } finally {
      console.error = originalError;
      // loadRecords 内部会把 process.exitCode 设成 1（真实 CLI 行为，正确），
      // 但这是个全局副作用，测试完必须还原，否则会让整个 test runner 进程
      // 以退出码 1 结束，误报"测试失败"。
      process.exitCode = originalExitCode;
    }

    assert.equal(records, null, '文件不存在时应该返回 null，而不是抛异常或返回空数组');
    assert.ok(logs.some((l) => l.includes(missingPath)), '错误信息应该包含具体路径，方便定位');
    assert.ok(logs.some((l) => l.includes('sites.example.csv')), '错误信息应该提示可以从示例模板复制');
  });
});
