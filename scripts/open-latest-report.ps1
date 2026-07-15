# open-latest-report.ps1
# 用途："查看最新结果"桌面快捷方式对应的脚本：只查找最新一次真正生成过
# report.md 的运行目录（output\YYYY-MM-DD\<run_id>\），用 Windows 文件
# 资源管理器打开该目录，方便直接看到 report.md / AI 审查包等全部文件。
#
# 只读：不删除、不修改、不解压任何报告文件，只是打开一个资源管理器窗口。
#
# 支持中文路径：使用 $PSScriptRoot 定位项目根目录。

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $ProjectRoot 'output'

if (-not (Test-Path $OutputDir)) {
    Write-Host "还没有生成过任何报告（output 目录不存在）。请先运行一次监控。" -ForegroundColor Yellow
    exit 0
}

# "最新"以 report.md 文件本身的最后修改时间为准——这是每次生成报告时
# 真正被重写的文件，比目录名（run_id 是 UUID，不能按时间排序）更可靠。
$LatestReport = Get-ChildItem -Path $OutputDir -Recurse -Filter 'report.md' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $LatestReport) {
    Write-Host "还没有生成过任何报告（output 目录下没有找到 report.md）。请先运行一次监控。" -ForegroundColor Yellow
    exit 0
}

$RunDir = $LatestReport.DirectoryName
Write-Host "正在打开最新的报告目录：$RunDir"
Start-Process explorer.exe $RunDir
