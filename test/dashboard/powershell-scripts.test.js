import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(__dirname, '..', '..', 'scripts');

const SCRIPTS = ['start-dashboard.ps1', 'run-and-open-dashboard.ps1', 'stop-dashboard.ps1', 'create-desktop-shortcuts.ps1'];

/**
 * 沙盒环境没有真实 Windows PowerShell 运行时，这里只能做文本级静态校验，
 * 不等于脚本在 PowerShell 5.1/7 下语法和行为正确。真实运行验证见
 * docs/dashboard-local-acceptance.md 的"本地待验证清单"。
 */
for (const name of SCRIPTS) {
  test(`${name}：以 UTF-8 BOM 开头（避免 Windows PowerShell 5.1 中文乱码）`, () => {
    const buf = readFileSync(join(scriptsDir, name));
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  test(`${name}：不包含硬编码的沙盒/临时目录绝对路径`, () => {
    const content = readFileSync(join(scriptsDir, name), 'utf-8');
    assert.doesNotMatch(content, /\/home\/user\//);
    assert.doesNotMatch(content, /\/tmp\//);
  });

  test(`${name}：不包含硬编码的 Windows 用户桌面绝对路径`, () => {
    const content = readFileSync(join(scriptsDir, name), 'utf-8');
    assert.doesNotMatch(content, /C:\\Users\\[^\\]+\\Desktop/);
  });

  // stop-dashboard.ps1 只通过 HTTP 探测端口 + 按 pid 终止进程，本来就不需要
  // 定位任何项目内文件路径，所以不强制要求它使用 $PSScriptRoot。
  if (name !== 'stop-dashboard.ps1') {
    test(`${name}：使用 $PSScriptRoot 动态定位脚本目录，不依赖调用时的当前工作目录`, () => {
      const content = readFileSync(join(scriptsDir, name), 'utf-8');
      assert.match(content, /\$PSScriptRoot/);
    });
  }
}

test('start-dashboard.ps1：包含找不到 Node 时的中文错误提示分支', () => {
  const content = readFileSync(join(scriptsDir, 'start-dashboard.ps1'), 'utf-8');
  assert.match(content, /未找到 Node\.js/);
});

test('start-dashboard.ps1：包含 Node 主版本检查逻辑', () => {
  const content = readFileSync(join(scriptsDir, 'start-dashboard.ps1'), 'utf-8');
  assert.match(content, /node --version/);
  assert.match(content, /major -lt 20/);
});

test('start-dashboard.ps1：明确说明 PowerShell 窗口关闭后服务的运行行为', () => {
  const content = readFileSync(join(scriptsDir, 'start-dashboard.ps1'), 'utf-8');
  assert.match(content, /关闭本 PowerShell 窗口不会停止/);
});

test('start-dashboard.ps1：不会自动开始采集（只等待 health 并打开浏览器）', () => {
  const content = readFileSync(join(scriptsDir, 'start-dashboard.ps1'), 'utf-8');
  assert.doesNotMatch(content, /\/api\/runs/);
});

test('stop-dashboard.ps1：提供正常停止方式，且先校验 service 标识再终止进程', () => {
  const content = readFileSync(join(scriptsDir, 'stop-dashboard.ps1'), 'utf-8');
  assert.match(content, /sitemap-dashboard/);
  assert.match(content, /Stop-Process/);
});

test('create-desktop-shortcuts.ps1：创建两个指定名称的快捷方式', () => {
  const content = readFileSync(join(scriptsDir, 'create-desktop-shortcuts.ps1'), 'utf-8');
  assert.match(content, /Sitemap监控面板/);
  assert.match(content, /运行Sitemap监控/);
});

test('create-desktop-shortcuts.ps1：使用 GetFolderPath 动态获取桌面路径，不写死路径', () => {
  const content = readFileSync(join(scriptsDir, 'create-desktop-shortcuts.ps1'), 'utf-8');
  assert.match(content, /\[Environment\]::GetFolderPath\('Desktop'\)/);
});
