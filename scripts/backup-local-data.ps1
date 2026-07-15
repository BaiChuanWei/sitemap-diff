# backup-local-data.ps1
# 用途：把数据库和配置文件备份到 backups\YYYY-MM-DD_HHmmss\，供
# restore-local-data.ps1 恢复使用，也供人工手动保存。
#
# 白名单式备份：只备份下面 $SourceFiles 里明确列出的几个文件，默认绝不
# 备份 node_modules、.git、output（报告可以随时重新生成，不算需要保护的
# 原始数据）或任何临时文件。
#
# 面板运行时拒绝备份：直接 Copy-Item 复制正被面板进程打开的 SQLite 文件
# （WAL 模式）可能拿到一份不一致的快照。本脚本不自动停止服务、不实现
# 在线 SQLite 备份、不提供绕过检查的 Force 参数——发现面板在跑就直接
# 拒绝，明确提示用户自己先执行 stop-dashboard.ps1。
#
# 支持中文路径：使用 $PSScriptRoot 定位项目根目录。
#
# 输出：脚本最后一行把生成的备份目录完整路径写到标准输出（Write-Output），
# 供 restore-local-data.ps1 在"恢复前自动备份当前数据"时直接捕获，不需要
# 靠猜测"最新的备份目录是哪个"。

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot

# ---- 0. 面板服务运行中拒绝备份 ----
$Port = 8766
if ($env:SITEMAP_DASHBOARD_PORT) { $Port = [int]$env:SITEMAP_DASHBOARD_PORT }
try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2 -Headers @{ Host = "127.0.0.1:$Port" }
    $envelope = $health.Content | ConvertFrom-Json
    if ($envelope.data -and $envelope.data.service -eq 'sitemap-dashboard') {
        Write-Host "错误：Sitemap 监控面板服务正在运行（端口 $Port，pid=$($envelope.data.pid)）。" -ForegroundColor Red
        Write-Host "直接复制正在被面板进程打开的数据库文件可能得到不一致的快照，拒绝备份。" -ForegroundColor Red
        Write-Host "请先执行以下命令停止面板服务，再重新运行备份：" -ForegroundColor Red
        Write-Host "  .\scripts\stop-dashboard.ps1" -ForegroundColor Red
        exit 1
    }
} catch {
    # 连接被拒绝/超时：视为服务未运行，正常继续。
}

$Timestamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$BackupDir = Join-Path (Join-Path $ProjectRoot 'backups') $Timestamp

# 白名单：Required=$true 的文件缺失时只警告（比如还没运行过一次），
# Required=$false 的是可选文件（比如从没写过审计日志）。
$SourceFiles = @(
    @{ RelPath = 'data\local.db'; Required = $true },
    @{ RelPath = 'config\sites.csv'; Required = $true },
    @{ RelPath = 'config\site-limits.csv'; Required = $false },
    @{ RelPath = 'config\site-sitemaps.csv'; Required = $false },
    @{ RelPath = 'logs\config-audit.jsonl'; Required = $false }
)

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

$IncludedFiles = @()
foreach ($entry in $SourceFiles) {
    $SourcePath = Join-Path $ProjectRoot $entry.RelPath
    if (Test-Path $SourcePath) {
        $DestPath = Join-Path $BackupDir $entry.RelPath
        $DestDir = Split-Path -Parent $DestPath
        if (-not (Test-Path $DestDir)) {
            New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
        }
        Copy-Item -Path $SourcePath -Destination $DestPath -Force
        $IncludedFiles += $entry.RelPath.Replace('\', '/')
        Write-Host "已备份：$($entry.RelPath)" -ForegroundColor Green
    } elseif ($entry.Required) {
        Write-Host "警告：$($entry.RelPath) 不存在，跳过（可能还没有运行过）。" -ForegroundColor Yellow
    } else {
        Write-Host "[信息] $($entry.RelPath) 不存在（可选文件），跳过。"
    }
}

if ($IncludedFiles.Count -eq 0) {
    Write-Host "错误：没有任何文件可以备份（数据库和配置文件都不存在）。" -ForegroundColor Red
    Remove-Item -Path $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

$DbPath = Join-Path $ProjectRoot 'data\local.db'
$DbSize = 0
if (Test-Path $DbPath) {
    $DbSize = (Get-Item $DbPath).Length
}

$GitCommit = 'unknown'
try {
    Push-Location $ProjectRoot
    $gitOutput = & git rev-parse HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $gitOutput) {
        $GitCommit = $gitOutput.Trim()
    }
} catch {
    $GitCommit = 'unknown'
} finally {
    Pop-Location
}

$NodeVersion = 'unknown'
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
    $NodeVersion = (& node --version).Trim()
}

$Manifest = [ordered]@{
    createdAt          = (Get-Date).ToString('o')
    gitCommit           = $GitCommit
    nodeVersion         = $NodeVersion
    databaseSizeBytes   = $DbSize
    includedFiles       = $IncludedFiles
}
$ManifestPath = Join-Path $BackupDir 'backup-manifest.json'
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8

Write-Host ""
Write-Host "备份完成：$BackupDir" -ForegroundColor Green
Write-Host "清单文件：$ManifestPath"

# 供其它脚本（restore-local-data.ps1）捕获——必须是脚本唯一的
# Write-Output，避免上面的 Write-Host 提示信息混进管道输出。
Write-Output $BackupDir
