# restore-local-data.ps1
# 用途：从 backup-local-data.ps1 生成的备份目录恢复数据库和配置文件。
#
# 安全设计：
#   - 必须显式传入 -BackupDir，不接受"自动选最新一份"这种隐式行为；
#   - 恢复前确认面板服务未运行（避免覆盖正被进程打开的 SQLite 文件）；
#   - 校验 backup-manifest.json 存在且是合法 JSON；
#   - 只从写死的 $RestorableFiles 相对路径清单里读取/写入文件，绝不使用
#     manifest 内容本身拼接文件路径——防止被篡改过的 manifest 诱导读写
#     清单之外的任意路径（路径穿越防护）；
#   - 恢复前自动调用 backup-local-data.ps1 备份当前数据；
#   - 每个文件都是"复制到临时文件 + 原子替换"，不会出现半写入状态；
#   - 恢复后对数据库做 SQLite 完整性检查；
#   - 任一步失败，把已经恢复的文件从"恢复前自动备份"整体回滚，不留半份
#     数据库或配置。
#   - 每一步写入前都校验目标路径确实在项目目录内部，拒绝写到项目目录之外。

param(
    [Parameter(Mandatory = $true)]
    [string]$BackupDir
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ProjectRootFull = (Resolve-Path $ProjectRoot).Path

# 固定的可恢复文件清单——顺序即恢复顺序。
$RestorableFiles = @(
    'data\local.db',
    'config\sites.csv',
    'config\site-limits.csv',
    'config\site-sitemaps.csv',
    'logs\config-audit.jsonl'
)

function Assert-WithinProject {
    param([string]$FullPath)
    $Normalized = [System.IO.Path]::GetFullPath($FullPath)
    if (-not $Normalized.StartsWith($ProjectRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "安全校验失败：$FullPath 不在项目目录 $ProjectRootFull 之内，拒绝写入。"
    }
}

# 同一文件系统内的"复制到临时文件 + 原子替换"：
#   目标已存在 -> [System.IO.File]::Replace（Windows ReplaceFile API，PS 5.1/7 都支持）；
#   目标不存在 -> 直接 Move，不存在"覆盖谁"的问题，天然没有中间态。
function Move-FileAtomic {
    param([string]$Source, [string]$Destination)
    if (Test-Path $Destination) {
        [System.IO.File]::Replace($Source, $Destination, $null)
    } else {
        [System.IO.File]::Move($Source, $Destination)
    }
}

# ---- 1. 备份目录必须真实存在，解析为绝对路径 ----
if (-not (Test-Path $BackupDir)) {
    Write-Host "错误：备份目录不存在：$BackupDir" -ForegroundColor Red
    exit 1
}
$ResolvedBackupDir = (Resolve-Path $BackupDir).Path

# ---- 2. backup-manifest.json 必须存在且能解析 ----
$ManifestPath = Join-Path $ResolvedBackupDir 'backup-manifest.json'
if (-not (Test-Path $ManifestPath)) {
    Write-Host "错误：$ResolvedBackupDir 下找不到 backup-manifest.json，这不是一个有效的备份目录，拒绝恢复。" -ForegroundColor Red
    exit 1
}
try {
    $Manifest = Get-Content -Path $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Host "错误：backup-manifest.json 不是合法 JSON，拒绝恢复：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
Write-Host "备份创建时间：$($Manifest.createdAt)"
Write-Host "备份时的 Git commit：$($Manifest.gitCommit)"
Write-Host "备份时的 Node 版本：$($Manifest.nodeVersion)"

# ---- 3. 确认面板服务未运行 ----
$Port = 8766
if ($env:SITEMAP_DASHBOARD_PORT) { $Port = [int]$env:SITEMAP_DASHBOARD_PORT }
try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2 -Headers @{ Host = "127.0.0.1:$Port" }
    $envelope = $health.Content | ConvertFrom-Json
    if ($envelope.data -and $envelope.data.service -eq 'sitemap-dashboard') {
        Write-Host "错误：面板服务正在运行（pid=$($envelope.data.pid)）。请先运行 stop-dashboard.ps1 停止服务，再执行恢复。" -ForegroundColor Red
        exit 1
    }
} catch {
    # 连接被拒绝/超时：视为服务未运行，正常继续。
}

# ---- 4. 校验备份目录里有哪些必要文件实际存在（仍然只按固定相对路径清单检查） ----
$AvailableInBackup = @()
foreach ($rel in $RestorableFiles) {
    $srcPath = Join-Path $ResolvedBackupDir $rel
    if (Test-Path $srcPath) {
        $AvailableInBackup += $rel
    }
}
if ($AvailableInBackup.Count -eq 0) {
    Write-Host "错误：备份目录里没有找到任何可恢复的文件（data\local.db / config\*.csv）。" -ForegroundColor Red
    exit 1
}
Write-Host "备份中可恢复的文件：$($AvailableInBackup -join ', ')"

# ---- 5. 恢复前自动备份当前数据 ----
Write-Host ""
Write-Host "正在恢复前自动备份当前数据..."
$BackupScript = Join-Path $PSScriptRoot 'backup-local-data.ps1'
$BackupOutput = & $BackupScript
if ($LASTEXITCODE -ne 0) {
    Write-Host "错误：恢复前自动备份失败（退出码 $LASTEXITCODE），为安全起见中止恢复。" -ForegroundColor Red
    exit 1
}
$PreRestoreBackupDir = ($BackupOutput | Select-Object -Last 1)
if (-not $PreRestoreBackupDir -or -not (Test-Path $PreRestoreBackupDir)) {
    Write-Host "错误：恢复前自动备份未返回有效的备份目录，为安全起见中止恢复。" -ForegroundColor Red
    exit 1
}
Write-Host "恢复前自动备份完成：$PreRestoreBackupDir"
Write-Host ""

# ---- 6. 逐个文件恢复：复制到临时文件 + 原子替换；任一步失败立即停止，转入回滚 ----
$RestoredFiles = @()
$RollbackNeeded = $false
$FailureMessage = $null

foreach ($rel in $AvailableInBackup) {
    $srcPath = Join-Path $ResolvedBackupDir $rel
    $destPath = Join-Path $ProjectRoot $rel
    $tmpPath = $null
    try {
        Assert-WithinProject -FullPath $destPath

        $destDir = Split-Path -Parent $destPath
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }

        $tmpPath = "$destPath.tmp-$([guid]::NewGuid().ToString('N'))"
        Copy-Item -Path $srcPath -Destination $tmpPath -Force
        Move-FileAtomic -Source $tmpPath -Destination $destPath
        $RestoredFiles += $rel
        Write-Host "已恢复：$rel" -ForegroundColor Green
    } catch {
        $RollbackNeeded = $true
        $FailureMessage = "恢复 $rel 失败：$($_.Exception.Message)"
        if ($tmpPath -and (Test-Path $tmpPath)) { Remove-Item -Path $tmpPath -Force -ErrorAction SilentlyContinue }
        break
    }
}

# ---- 7. 恢复后对数据库做完整性检查；不通过也视为失败，触发回滚 ----
if (-not $RollbackNeeded -and ($RestoredFiles -contains 'data\local.db')) {
    $RestoredDbPath = Join-Path $ProjectRoot 'data\local.db'
    $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($NodeCmd) {
        $integrityScript = "const Database = require('better-sqlite3'); const db = new Database(process.argv[1], { readonly: true, fileMustExist: true }); const result = db.pragma('integrity_check', { simple: true }); process.stdout.write(String(result)); db.close();"
        Push-Location $ProjectRoot
        try {
            $integrityResult = & node -e $integrityScript -- $RestoredDbPath 2>&1
        } finally {
            Pop-Location
        }
        if ($integrityResult -ne 'ok') {
            $RollbackNeeded = $true
            $FailureMessage = "恢复后的数据库未通过完整性检查：$integrityResult"
        } else {
            Write-Host "恢复后的数据库完整性检查（PRAGMA integrity_check）通过。" -ForegroundColor Green
        }
    } else {
        Write-Host "警告：未找到 Node.js，跳过恢复后的数据库完整性检查。" -ForegroundColor Yellow
    }
}

# ---- 8. 失败时整体回滚，不留半份数据库或配置 ----
if ($RollbackNeeded) {
    Write-Host ""
    Write-Host "错误：$FailureMessage" -ForegroundColor Red
    Write-Host "正在从恢复前自动备份回滚..." -ForegroundColor Yellow
    foreach ($rel in $RestoredFiles) {
        $rollbackSrc = Join-Path $PreRestoreBackupDir $rel
        $rollbackDest = Join-Path $ProjectRoot $rel
        if (Test-Path $rollbackSrc) {
            $tmpPath = "$rollbackDest.tmp-$([guid]::NewGuid().ToString('N'))"
            Copy-Item -Path $rollbackSrc -Destination $tmpPath -Force
            Move-FileAtomic -Source $tmpPath -Destination $rollbackDest
        }
    }
    Write-Host "已回滚到恢复前的状态。恢复前的自动备份仍保留在：$PreRestoreBackupDir" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "恢复完成，共恢复 $($RestoredFiles.Count) 个文件：$($RestoredFiles -join ', ')" -ForegroundColor Green
Write-Host "恢复前的自动备份保留在：$PreRestoreBackupDir"
