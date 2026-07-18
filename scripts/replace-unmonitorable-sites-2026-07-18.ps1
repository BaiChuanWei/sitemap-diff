# replace-unmonitorable-sites-2026-07-18.ps1
# 一次性配置迁移：
# 1. 将已经过真实测试、当前无法稳定监控的站点设为 enabled=false；
# 2. 保留这些站点的历史数据库记录和诊断备注；
# 3. 新增用户指定的 20 个候选站点并启用；
# 4. 自动备份原始 config/*.csv，临时文件验证通过后再原子替换 sites.csv。
#
# 本脚本可重复执行：已暂停的站点不会重复修改，已存在的新站点不会重复添加。

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SitesCsv = Join-Path $ProjectRoot 'config\sites.csv'
$ConfigDir = Join-Path $ProjectRoot 'config'
$Timestamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$BackupDir = Join-Path $ConfigDir "backups\site-replacement-$Timestamp"

# 面板运行时禁止修改配置，避免面板写入与本脚本互相覆盖。
$Port = 8766
if ($env:SITEMAP_DASHBOARD_PORT) { $Port = [int]$env:SITEMAP_DASHBOARD_PORT }
try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2 -Headers @{ Host = "127.0.0.1:$Port" }
    $envelope = $health.Content | ConvertFrom-Json
    if ($envelope.data -and $envelope.data.service -eq 'sitemap-dashboard') {
        Write-Host "错误：Sitemap 监控面板正在运行（pid=$($envelope.data.pid)）。" -ForegroundColor Red
        Write-Host '请先运行 .\scripts\stop-dashboard.ps1，再执行本脚本。' -ForegroundColor Red
        exit 1
    }
} catch {
    # 连接被拒绝或超时，说明面板未运行，可以继续。
}

if (-not (Test-Path $SitesCsv)) {
    throw "找不到站点配置：$SitesCsv"
}

# 已经过项目真实测试、当前明确无法稳定监控的站点。
# lagged 不在此列表：它已经在 site-sitemaps.csv 中配置了可用的手工 Sitemap。
$DisableSiteIds = @(
    'crazygames_2',
    '4399',
    'a10',
    'agame',
    'gamejolt',
    'gamesgames',
    'silvergames',
    'amzgame',
    'animalbrainrot',
    'azgames',
    'flipline',
    'funhtml5games',
    'gahe',
    'gamaverse',
    'gamesfreak',
    'html5games',
    'juegos',
    'mousebreaker',
    'playbrain',
    'plays',
    'spel',
    'spelletjes',
    'vseigru',
    'webgames',
    'armorgames',
    'gameflare',
    'newgrounds',
    'spelle'
)

$NewSites = @(
    [pscustomobject]@{ site_id='thekidattheback'; domain='thekidattheback.net'; priority='medium'; enabled='true'; robots_url='https://thekidattheback.net/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='the_false_sun'; domain='the-false-sun.com'; priority='medium'; enabled='true'; robots_url='https://the-false-sun.com/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='sprunkiscrunkly'; domain='sprunkiscrunkly.com'; priority='medium'; enabled='true'; robots_url='https://sprunkiscrunkly.com/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='musicgames'; domain='musicgames.io'; priority='medium'; enabled='true'; robots_url='https://musicgames.io/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='fandom'; domain='fandom.com'; priority='medium'; enabled='true'; robots_url='https://www.fandom.com/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增；平台根域名，需诊断其Sitemap是否覆盖有价值页面'; site_category='' },
    [pscustomobject]@{ site_id='gx_games'; domain='gx.games'; priority='medium'; enabled='true'; robots_url='https://gx.games/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='indiedb'; domain='indiedb.com'; priority='medium'; enabled='true'; robots_url='https://www.indiedb.com/robots.txt'; sitemap_url=''; expected_game_path='/games/'; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='construct'; domain='construct.net'; priority='medium'; enabled='true'; robots_url='https://www.construct.net/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='novelgame'; domain='novelgame.jp'; priority='medium'; enabled='true'; robots_url='https://novelgame.jp/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='thefreakcircus'; domain='thefreakcircus.org'; priority='medium'; enabled='true'; robots_url='https://thefreakcircus.org/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='1001spiele'; domain='1001spiele.de'; priority='medium'; enabled='true'; robots_url='https://www.1001spiele.de/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='spielaffe'; domain='spielaffe.de'; priority='medium'; enabled='true'; robots_url='https://www.spielaffe.de/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='garticphone'; domain='garticphone.com'; priority='medium'; enabled='true'; robots_url='https://garticphone.com/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增；单游戏站，页面变化频率可能较低'; site_category='' },
    [pscustomobject]@{ site_id='gartic'; domain='gartic.io'; priority='medium'; enabled='true'; robots_url='https://gartic.io/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增；单游戏站，页面变化频率可能较低'; site_category='' },
    [pscustomobject]@{ site_id='hotgames'; domain='hotgames.io'; priority='medium'; enabled='true'; robots_url='https://hotgames.io/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='escape_tsunami_brainrots'; domain='escapetsunamiforbrainrots.io'; priority='medium'; enabled='true'; robots_url='https://escapetsunamiforbrainrots.io/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增；单游戏专题站，页面变化频率可能较低'; site_category='' },
    [pscustomobject]@{ site_id='spacewaves2'; domain='spacewaves2.org'; priority='medium'; enabled='true'; robots_url='https://spacewaves2.org/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增；单游戏专题站，页面变化频率可能较低'; site_category='' },
    [pscustomobject]@{ site_id='geometrylitepc'; domain='geometrylitepc.io'; priority='medium'; enabled='true'; robots_url='https://geometrylitepc.io/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增；单游戏专题站，页面变化频率可能较低'; site_category='' },
    [pscustomobject]@{ site_id='zapgames'; domain='zapgames.io'; priority='medium'; enabled='true'; robots_url='https://zapgames.io/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增，尚未完成真实诊断；首次可靠运行只建立baseline'; site_category='' },
    [pscustomobject]@{ site_id='gamemonetize'; domain='gamemonetize.com'; priority='medium'; enabled='true'; robots_url='https://gamemonetize.com/robots.txt'; sitemap_url=''; expected_game_path=''; notes='2026-07-18替换新增；游戏分发平台，需诊断Sitemap规模和限流情况'; site_category='' }
)

function Replace-FileAtomic {
    param([string]$Source, [string]$Destination)

    $DestinationFull = [System.IO.Path]::GetFullPath($Destination)
    if (Test-Path $DestinationFull) {
        $replaceBackup = "$DestinationFull.replace-backup-$([guid]::NewGuid().ToString('N'))"
        try {
            [System.IO.File]::Replace($Source, $DestinationFull, $replaceBackup)
        } finally {
            if (Test-Path $replaceBackup) {
                Remove-Item -LiteralPath $replaceBackup -Force -ErrorAction SilentlyContinue
            }
        }
    } else {
        [System.IO.File]::Move($Source, $DestinationFull)
    }
}

# 先备份三份配置，方便人工恢复。
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
foreach ($name in @('sites.csv', 'site-limits.csv', 'site-sitemaps.csv')) {
    $source = Join-Path $ConfigDir $name
    if (Test-Path $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $BackupDir $name) -Force
    }
}
Write-Host "配置备份完成：$BackupDir" -ForegroundColor Green

$Rows = @(Import-Csv -LiteralPath $SitesCsv -Encoding UTF8)
$DisableSet = @{}
foreach ($id in $DisableSiteIds) { $DisableSet[$id.ToLowerInvariant()] = $true }

$DisabledCount = 0
foreach ($row in $Rows) {
    $idKey = ([string]$row.site_id).Trim().ToLowerInvariant()
    if ($DisableSet.ContainsKey($idKey)) {
        if (([string]$row.enabled).Trim().ToLowerInvariant() -ne 'false') {
            $row.enabled = 'false'
            $DisabledCount++
        }
        if (([string]$row.notes) -notlike '*2026-07-18按用户要求暂停*') {
            if ([string]::IsNullOrWhiteSpace([string]$row.notes)) {
                $row.notes = '2026-07-18按用户要求暂停：此前真实测试无法稳定监控；保留历史，后续可重新诊断恢复'
            } else {
                $row.notes = "$($row.notes)；2026-07-18按用户要求暂停：保留历史，后续可重新诊断恢复"
            }
        }
    }
}

$ExistingIds = @{}
$ExistingDomains = @{}
foreach ($row in $Rows) {
    $ExistingIds[([string]$row.site_id).Trim().ToLowerInvariant()] = $true
    $ExistingDomains[([string]$row.domain).Trim().ToLowerInvariant()] = $true
}

$AddedSites = @()
foreach ($site in $NewSites) {
    $idKey = $site.site_id.ToLowerInvariant()
    $domainKey = $site.domain.ToLowerInvariant()

    if ($ExistingIds.ContainsKey($idKey)) {
        Write-Host "跳过已有 site_id：$($site.site_id)" -ForegroundColor Yellow
        continue
    }
    if ($ExistingDomains.ContainsKey($domainKey)) {
        Write-Host "跳过已有域名：$($site.domain)" -ForegroundColor Yellow
        continue
    }

    $Rows += $site
    $AddedSites += $site
    $ExistingIds[$idKey] = $true
    $ExistingDomains[$domainKey] = $true
}

$Columns = @(
    'site_id',
    'domain',
    'priority',
    'enabled',
    'robots_url',
    'sitemap_url',
    'expected_game_path',
    'notes',
    'site_category'
)

$TempPath = Join-Path $ConfigDir "sites.csv.tmp-$([guid]::NewGuid().ToString('N'))"
try {
    $Rows |
        Select-Object $Columns |
        Export-Csv -LiteralPath $TempPath -NoTypeInformation -Encoding UTF8

    $Verified = @(Import-Csv -LiteralPath $TempPath -Encoding UTF8)
    if ($Verified.Count -ne $Rows.Count) {
        throw "写入验证失败：预期 $($Rows.Count) 行，实际 $($Verified.Count) 行。"
    }

    $seenIds = @{}
    $seenDomains = @{}
    foreach ($row in $Verified) {
        $id = ([string]$row.site_id).Trim().ToLowerInvariant()
        $domain = ([string]$row.domain).Trim().ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($id) -or [string]::IsNullOrWhiteSpace($domain)) {
            throw '写入验证失败：存在空 site_id 或空 domain。'
        }
        if ($seenIds.ContainsKey($id)) { throw "写入验证失败：site_id 重复：$id" }
        if ($seenDomains.ContainsKey($domain)) { throw "写入验证失败：domain 重复：$domain" }
        $seenIds[$id] = $true
        $seenDomains[$domain] = $true
    }

    foreach ($id in $DisableSiteIds) {
        $matched = @($Verified | Where-Object { $_.site_id -eq $id })
        if ($matched.Count -ne 1 -or $matched[0].enabled -ne 'false') {
            throw "写入验证失败：$id 没有被正确暂停。"
        }
    }

    foreach ($site in $AddedSites) {
        $matched = @($Verified | Where-Object { $_.site_id -eq $site.site_id })
        if ($matched.Count -ne 1 -or $matched[0].enabled -ne 'true') {
            throw "写入验证失败：$($site.site_id) 没有被正确新增并启用。"
        }
    }

    Replace-FileAtomic -Source $TempPath -Destination $SitesCsv
    $TempPath = $null
} finally {
    if ($TempPath -and (Test-Path $TempPath)) {
        Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host '站点替换完成。' -ForegroundColor Green
Write-Host "本次新暂停：$DisabledCount 个（总目标 28 个；重复执行时已暂停站点不重复计数）"
Write-Host "本次新增：$($AddedSites.Count) 个（目标 20 个；已存在站点会自动跳过）"
Write-Host "当前配置总行数：$($Rows.Count)"
Write-Host "备份目录：$BackupDir"
Write-Host ''
Write-Host '新增站点：'
$AddedSites | Select-Object site_id, domain | Format-Table -AutoSize
Write-Host '下一步：运行 .\scripts\check-installation.ps1，然后启动面板并对新增站点分批诊断。'
