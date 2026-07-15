import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(__dirname, '..', '..', 'scripts');

const SCRIPTS = [
  'start-dashboard.ps1', 'run-and-open-dashboard.ps1', 'stop-dashboard.ps1', 'create-desktop-shortcuts.ps1',
  // Dashboard M6：Windows 本地发布验收新增的运维脚本。
  'check-installation.ps1', 'open-latest-report.ps1', 'backup-local-data.ps1', 'restore-local-data.ps1',
];

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

// Dashboard M2 起 /api/health 的响应体从 { service, pid, ... } 改成了
// { ok:true, data:{ service, pid, ... } } 信封格式，start-dashboard.ps1 和
// stop-dashboard.ps1 当时都没有跟着改，导致 $body.service/$body.pid 永远
// 是 $null——启动脚本会把"服务其实已经在运行"误判成"没在运行"而重复启动，
// 停止脚本会把"就是本项目的服务"误判成"不是"而拒绝停止。这两条测试锁定
// 修复后的 .data 解包，防止同类回归。
test('start-dashboard.ps1：health 检查从信封的 .data 里取字段，不直接读顶层', () => {
  const content = readFileSync(join(scriptsDir, 'start-dashboard.ps1'), 'utf-8');
  assert.match(content, /\$envelope\.data/);
  assert.match(content, /\$body\.service/);
});

test('stop-dashboard.ps1：health 检查从信封的 .data 里取字段，不直接读顶层', () => {
  const content = readFileSync(join(scriptsDir, 'stop-dashboard.ps1'), 'utf-8');
  assert.match(content, /\$envelope\.data/);
  assert.match(content, /\$body\.pid/);
});

test('run-and-open-dashboard.ps1：通过 ?action=start-all 打开浏览器触发一键启动，不在脚本里直接调用写接口', () => {
  const content = readFileSync(join(scriptsDir, 'run-and-open-dashboard.ps1'), 'utf-8');
  assert.match(content, /\?action=start-all/);
  // 不应该在 PowerShell 里自己拼 CSRF token/POST body 去调 /api/runs——
  // 那套认证逻辑只应该存在于 app.js 一处，脚本只负责打开对应的 URL。
  assert.doesNotMatch(content, /Invoke-WebRequest.*\/api\/runs/);
  assert.doesNotMatch(content, /Invoke-RestMethod.*\/api\/runs/);
});

test('run-and-open-dashboard.ps1：只打开一个浏览器窗口（借助 start-dashboard.ps1 的 -NoBrowser）', () => {
  const content = readFileSync(join(scriptsDir, 'run-and-open-dashboard.ps1'), 'utf-8');
  assert.match(content, /-NoBrowser/);
});

test('create-desktop-shortcuts.ps1：创建三个指定名称的快捷方式（含 M6 新增的"查看最新结果"）', () => {
  const content = readFileSync(join(scriptsDir, 'create-desktop-shortcuts.ps1'), 'utf-8');
  assert.match(content, /Sitemap监控面板/);
  assert.match(content, /运行Sitemap监控/);
  assert.match(content, /查看最新结果/);
  assert.match(content, /open-latest-report\.ps1/);
});

test('create-desktop-shortcuts.ps1：使用 GetFolderPath 动态获取桌面路径，不写死路径', () => {
  const content = readFileSync(join(scriptsDir, 'create-desktop-shortcuts.ps1'), 'utf-8');
  assert.match(content, /\[Environment\]::GetFolderPath\('Desktop'\)/);
});

// ---- Dashboard M6：Windows 本地发布验收新增脚本 ----

/**
 * 近似去除 PowerShell 双引号字符串字面量的内容（含反引号转义的 `" ），
 * 只用于测试断言"这段危险命令是不是真的会被当作语句执行"，不是通用
 * PowerShell 解析器——本项目的修复提示文案习惯用双引号字符串拼接跨行
 * 输出，直接按行过滤 Write-Host/Write-CheckFail 关键字会漏掉那些和
 * 字符串开头不在同一行的后续拼接行，所以改成去掉整个字符串字面量。
 */
function stripDoubleQuotedStrings(text) {
  return text.replace(/"(?:`.|[^"`])*"/gs, '""');
}
/** 去掉整行注释（trim 后以 # 开头），用于断言"这只是在注释里提到，不是真的默认这么做"。 */
function stripCommentLines(text) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

test('check-installation.ps1：只读体检，不包含任何破坏性操作（删 node_modules / 自动装 Node / 改 PATH / 删数据库 / 杀未知进程）', () => {
  const content = readFileSync(join(scriptsDir, 'check-installation.ps1'), 'utf-8');
  const codeOnly = stripDoubleQuotedStrings(stripCommentLines(content));
  assert.doesNotMatch(codeOnly, /Remove-Item[^\n]*node_modules/, '不得在真正执行的语句里删除 node_modules');
  assert.doesNotMatch(codeOnly, /npm\s+install/, '不得自动执行 npm install');
  assert.doesNotMatch(codeOnly, /SetEnvironmentVariable[^\n]*PATH/i, '不得修改系统 PATH');
  assert.doesNotMatch(codeOnly, /Remove-Item[^\n]*local\.db/, '不得删除数据库文件');
  assert.doesNotMatch(codeOnly, /Stop-Process/, '不得包含终止进程的代码（体检脚本只读）');
  // 唯一允许的写操作：output 目录可写性探测用的临时文件，且必须紧跟着删除自己。
  assert.match(content, /Remove-Item -Path \$ProbeFile/, '写可用性探测必须清理掉自己创建的临时文件');
});

test('check-installation.ps1：ABI 127/137 冲突与 Node 22/24 混用有明确中文修复提示', () => {
  const content = readFileSync(join(scriptsDir, 'check-installation.ps1'), 'utf-8');
  assert.match(content, /NODE_MODULE_VERSION/);
  assert.match(content, /127/);
  assert.match(content, /137/);
  assert.match(content, /Node 24/);
  assert.match(content, /process\.versions\.modules/);
  assert.match(content, /Remove-Item -Recurse -Force node_modules/, '修复提示里必须包含具体可执行的修复命令');
});

test('backup-local-data.ps1：备份文件白名单正确，默认不包含 node_modules/.git/output/临时文件', () => {
  const content = readFileSync(join(scriptsDir, 'backup-local-data.ps1'), 'utf-8');
  const codeOnly = stripCommentLines(content); // 注释里提到"不备份 node_modules"是说明性文字，不代表脚本真的把它列进了白名单
  for (const required of ['data\\\\local.db', 'config\\\\sites.csv', 'config\\\\site-limits.csv', 'config\\\\site-sitemaps.csv']) {
    assert.match(content, new RegExp(required.replace(/\\\\/g, '\\\\')), `白名单必须包含 ${required}`);
  }
  assert.match(content, /logs\\config-audit\.jsonl/, '白名单必须包含可选的审计日志');
  assert.doesNotMatch(codeOnly, /node_modules/, '不得默认备份 node_modules');
  assert.doesNotMatch(codeOnly, /RelPath = '\.git'|RelPath = "\.git"|\\\.git\\/, '不得默认备份 .git');
  assert.doesNotMatch(codeOnly, /RelPath = 'output'|RelPath = "output"|\\output\\/, '不得默认备份 output 报告目录');
  assert.match(content, /backup-manifest\.json/, '必须生成 backup-manifest.json');
  assert.match(content, /gitCommit/);
  assert.match(content, /nodeVersion/);
  assert.match(content, /databaseSizeBytes/);
  assert.match(content, /includedFiles/);
});

test('restore-local-data.ps1：恢复保护措施齐全（必须显式指定备份目录/恢复前自动备份/原子替换/完整性校验/路径穿越防护/失败回滚）', () => {
  const content = readFileSync(join(scriptsDir, 'restore-local-data.ps1'), 'utf-8');
  assert.match(content, /Parameter\(Mandatory = \$true\)/, '必须要求显式指定 -BackupDir，不能有默认值');
  assert.match(content, /\$BackupDir/);
  assert.match(content, /api\/health/, '恢复前必须检查面板服务是否在运行');
  assert.match(content, /backup-manifest\.json/, '必须校验 backup-manifest.json');
  assert.match(content, /backup-local-data\.ps1/, '恢复前必须调用备份脚本自动备份当前数据');
  assert.match(content, /tmp-/, '必须使用临时文件做原子替换，不能直接覆盖目标文件');
  assert.match(content, /\[System\.IO\.File\]::Replace|\[System\.IO\.File\]::Move/, '必须使用 .NET 层面的原子替换/移动，不能只用 Move-Item -Force（在 PowerShell 里对已存在文件不保证原子）');
  assert.match(content, /integrity_check/, '恢复后必须做 SQLite 完整性检查');
  assert.match(content, /RollbackNeeded/, '失败时必须触发回滚逻辑');
  assert.match(content, /Assert-WithinProject/, '必须校验目标路径在项目目录内部（路径穿越防护）');
  assert.match(content, /StartsWith\(\$ProjectRootFull/, '路径穿越防护必须真的比较解析后的绝对路径前缀');
});

test('open-latest-report.ps1：按"最新且存在 report.md"选择运行目录，不自动删除/修改/解压报告', () => {
  const content = readFileSync(join(scriptsDir, 'open-latest-report.ps1'), 'utf-8');
  assert.match(content, /Get-ChildItem[^\n]*-Filter 'report\.md'/, '必须只在存在 report.md 的目录里挑选');
  assert.match(content, /Sort-Object LastWriteTime -Descending/, '必须按时间倒序找最新的');
  assert.match(content, /Select-Object -First 1/);
  assert.match(content, /Start-Process explorer\.exe/, '只应该打开资源管理器窗口');
  assert.doesNotMatch(content, /Remove-Item/, '不得删除任何报告文件');
  assert.doesNotMatch(content, /Expand-Archive/, '不得自动解压 zip');
  assert.doesNotMatch(content, /Set-Content|Out-File|Add-Content/, '不得修改任何报告文件');
});
