# run-and-open-dashboard.ps1
# 用途："运行 Sitemap 监控" 快捷方式对应的脚本：启动或复用面板服务，
# 并打开实时运行页。
#
# 当前版本（M1，只读面板）说明：
# 本里程碑尚未实现"通过接口触发开始全部监控"的能力（计划在 M3 完成）。
# 因此本脚本目前的行为是：确保面板服务运行 -> 打开面板首页，并在控制台
# 提示用户当前版本还不能从这里一键开始采集，如需立即采集请使用命令行：
#   node bin/run.js --collect
# M3 完成后，本脚本会改为自动调用"开始全部监控"接口。

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot 'start-dashboard.ps1'

& $StartScript

Write-Host ''
Write-Host '注意：当前面板版本（M1，只读）尚未提供"一键开始全部监控"功能，' -ForegroundColor Yellow
Write-Host '该能力计划在后续里程碑（M3）加入。如需立即开始采集，请在项目目录下运行：' -ForegroundColor Yellow
Write-Host '  node bin/run.js --collect' -ForegroundColor Yellow
