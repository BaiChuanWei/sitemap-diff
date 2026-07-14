# start-dashboard.ps1
# 用途：启动（或复用已运行的）Sitemap 监控本地面板，并自动打开浏览器。
# 本脚本不会开始任何采集任务，只负责让面板服务处于可访问状态。
#
# 支持中文路径：本脚本使用 $PSScriptRoot 定位项目根目录，不依赖调用时的
# 当前工作目录，也不硬编码任何绝对路径。

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot 'logs'
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$LogFile = Join-Path $LogDir 'dashboard.log'

function Get-DashboardPort {
    if ($env:SITEMAP_DASHBOARD_PORT) {
        return [int]$env:SITEMAP_DASHBOARD_PORT
    }
    return 8766
}

$Port = Get-DashboardPort
$HealthUrl = "http://127.0.0.1:$Port/api/health"
$DashboardUrl = "http://127.0.0.1:$Port"

function Test-NodeAvailable {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host '错误：未找到 Node.js，请先安装 Node.js 20 或更高版本（https://nodejs.org），然后重新运行本脚本。' -ForegroundColor Red
        return $false
    }
    $versionOutput = & node --version
    if ($versionOutput -match 'v(\d+)\.') {
        $major = [int]$Matches[1]
        if ($major -lt 20) {
            Write-Host "错误：检测到 Node.js 版本为 $versionOutput，本工具要求 Node.js 20 或更高版本，请升级后重试。" -ForegroundColor Red
            return $false
        }
    }
    return $true
}

function Test-DashboardHealthy {
    try {
        $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3 -Headers @{ Host = "127.0.0.1:$Port" }
        $body = $response.Content | ConvertFrom-Json
        if ($body.service -eq 'sitemap-dashboard') {
            return $true
        }
        return $false
    } catch {
        return $false
    }
}

function Start-DashboardProcess {
    if (-not (Test-NodeAvailable)) {
        exit 1
    }
    Write-Host "正在启动 Sitemap 监控面板服务（端口 $Port）..."
    $NodeExe = (Get-Command node).Source
    $DashboardScript = Join-Path $ProjectRoot 'bin\dashboard.js'
    Start-Process -FilePath $NodeExe -ArgumentList "`"$DashboardScript`"" `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError (Join-Path $LogDir 'dashboard-error.log') `
        -WindowStyle Hidden

    $maxAttempts = 20
    for ($i = 0; $i -lt $maxAttempts; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-DashboardHealthy) {
            Write-Host '面板服务已启动。' -ForegroundColor Green
            return
        }
    }
    Write-Host "错误：面板服务在预期时间内没有响应，请查看日志：$LogFile" -ForegroundColor Red
    exit 1
}

if (Test-DashboardHealthy) {
    Write-Host '检测到面板服务已经在运行，直接打开浏览器。'
} else {
    Start-DashboardProcess
}

Write-Host "正在打开浏览器：$DashboardUrl"
Start-Process $DashboardUrl

Write-Host ''
Write-Host '提示：关闭本 PowerShell 窗口不会停止后台的面板服务（服务以独立进程运行）。'
Write-Host "如需停止服务，请运行 stop-dashboard.ps1。"
