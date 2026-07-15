# backup-local-data.ps1
# 用途：把数据库和配置文件备份到 backups\YYYY-MM-DD_HHmmss\，供
# restore-local-data.ps1 恢复使用，也供人工手动保存。
#
# 白名单式备份：只备份下面 $SourceFiles 里明确列出的几个文件，默认绝不
# 备份 node_modules、.git、output（报告可以随时重新生成，不算需要保护的
# 原始数据）或任何临时文件。
#
# 支持中文路径：使用 $PSScriptRoot 定位项目根目录。
#
# 输出：脚本最后一行把生成的备份目录完整路径写到标准输出（Write-Output），
# 供 restore-local-data.ps1 在"恢复前自动备份当前数据"时直接捕获，不需要
# 靠猜测"最新的备份目录是哪个"。

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
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
