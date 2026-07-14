# stop-dashboard.ps1
# 用途：停止正在运行的 Sitemap 监控本地面板服务。
# 通过 /api/health 获取真实 pid 后再终止进程，避免误杀同端口上的其它程序。

$ErrorActionPreference = 'Stop'

function Get-DashboardPort {
    if ($env:SITEMAP_DASHBOARD_PORT) {
        return [int]$env:SITEMAP_DASHBOARD_PORT
    }
    return 8766
}

$Port = Get-DashboardPort
$HealthUrl = "http://127.0.0.1:$Port/api/health"

try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3 -Headers @{ Host = "127.0.0.1:$Port" }
    $envelope = $response.Content | ConvertFrom-Json
    # Dashboard M2 起 /api/health 的响应体是 { ok:true, data:{...} } 信封格式，
    # 真正的字段在 .data 下面，不是顶层——这里如果直接读 $envelope.service
    # 永远是 $null，会被下面的判断误判成"不是本项目的服务"而拒绝停止。
    $body = $envelope.data
} catch {
    Write-Host "端口 $Port 上没有检测到运行中的面板服务，无需停止。"
    exit 0
}

if (-not $body -or $body.service -ne 'sitemap-dashboard') {
    Write-Host "端口 $Port 上运行的不是本项目的面板服务，为安全起见不会终止该进程。" -ForegroundColor Yellow
    exit 1
}

$TargetPid = $body.pid
try {
    Stop-Process -Id $TargetPid -Force
    Write-Host "已停止面板服务（pid=$TargetPid）。" -ForegroundColor Green
} catch {
    Write-Host "错误：停止进程 pid=$TargetPid 失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
