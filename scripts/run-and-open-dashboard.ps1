# run-and-open-dashboard.ps1
# 用途："运行 Sitemap 监控" 桌面快捷方式对应的脚本：确保面板服务运行，
# 打开浏览器并自动开始全部站点的监控，直接进入实时运行页。
#
# 一键启动的实现方式：本脚本自己不直接调用写接口（不在 PowerShell 里处理
# CSRF token/JSON body），而是打开浏览器到 ?action=start-all，由页面加载后
# 的前端 JS（app.js 的 handleStartAllQueryParam）用它已经具备的 CSRF token
# 获取逻辑去调用 POST /api/runs——避免在这里重复实现一套认证逻辑，也让
# "点击快捷方式即代表明确同意开始运行"这件事只在一个地方判断。

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot 'start-dashboard.ps1'

function Get-DashboardPort {
    if ($env:SITEMAP_DASHBOARD_PORT) {
        return [int]$env:SITEMAP_DASHBOARD_PORT
    }
    return 8766
}

$Port = Get-DashboardPort

# -NoBrowser：只确保服务已启动/健康，浏览器由本脚本自己打开（带上
# ?action=start-all），避免打开两个浏览器窗口。
& $StartScript -NoBrowser

$RunUrl = "http://127.0.0.1:$Port/?action=start-all"
Write-Host "正在打开浏览器并开始全部监控：$RunUrl"
Start-Process $RunUrl

Write-Host ''
Write-Host '提示：关闭本 PowerShell 窗口不会停止后台的面板服务或正在进行的监控任务。'
Write-Host '如需安全停止正在进行的监控，请在面板"实时运行"页点击"安全停止"。'
