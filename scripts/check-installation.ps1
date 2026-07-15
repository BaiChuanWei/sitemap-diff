# check-installation.ps1
# 用途：Windows 本地环境体检——只读检查，不做任何修改。
#
# 本脚本只读：不删除 node_modules，不自动安装/卸载 Node，不修改系统 PATH，
# 不删除数据库，不终止任何进程。发现问题时只打印中文诊断信息和建议的
# 修复命令，由用户自己决定要不要执行。
#
# 支持中文路径：使用 $PSScriptRoot 定位项目根目录，不依赖调用时的当前
# 工作目录，也不硬编码任何绝对路径。

$ErrorActionPreference = 'Continue'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:FailCount = 0
$script:WarnCount = 0

function Write-CheckOk {
    param([string]$Message)
    Write-Host "[OK]   $Message" -ForegroundColor Green
}
function Write-CheckWarn {
    param([string]$Message)
    Write-Host "[警告] $Message" -ForegroundColor Yellow
    $script:WarnCount++
}
function Write-CheckFail {
    param([string]$Message)
    Write-Host "[错误] $Message" -ForegroundColor Red
    $script:FailCount++
}

Write-Host "===================================================="
Write-Host "Sitemap 监控本地环境体检"
Write-Host "===================================================="
Write-Host "项目根目录：$ProjectRoot"
Write-Host ""

# ---- 1. Node.js ----
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-CheckFail "未找到 Node.js。请安装 Node.js 22（本项目开发/验收使用的版本），下载地址：https://nodejs.org/ 。"
} else {
    $NodeVersionRaw = & node --version
    Write-Host "Node.js 路径：$($NodeCmd.Source)"
    Write-Host "Node.js 版本：$NodeVersionRaw"

    if ($NodeVersionRaw -match 'v(\d+)\.') {
        $NodeMajor = [int]$Matches[1]
        if ($NodeMajor -eq 22) {
            Write-CheckOk "Node.js 主版本为 22。"
        } elseif ($NodeMajor -eq 24) {
            Write-CheckWarn ("检测到 Node.js 24（本机可能同时装了 Node 22 和 Node 24）。" +
                "本项目的原生模块（better-sqlite3）是针对 Node 22 的 ABI（NODE_MODULE_VERSION 127）编译的，" +
                "Node 24 的 ABI 是 137，两者不兼容，混用会导致 better-sqlite3 加载失败并报 " +
                "'NODE_MODULE_VERSION 127' 与当前 Node 版本不匹配的错误。" +
                "修复方法：确保 PATH 里排在前面的是 Node 22（例如直接调用 " +
                "D:\Tools\node-v22.23.1-win-x64\node.exe），或者用 nvm-windows 切换到 Node 22 后执行：" +
                "cd `"$ProjectRoot`"; Remove-Item -Recurse -Force node_modules; npm install")
        } else {
            Write-CheckWarn "Node.js 主版本为 $NodeMajor，本项目建议使用 Node.js 22。较低版本可能缺少必要的语言特性，较高版本可能与已编译的原生模块 ABI 不兼容。"
        }
    }

    $AbiOutput = & node -e "process.stdout.write(String(process.versions.modules))" 2>$null
    Write-Host "Node.js 原生模块 ABI（process.versions.modules）：$AbiOutput"
    if ($AbiOutput -eq '127') {
        Write-CheckOk "原生模块 ABI 是 127，和 Node 22 匹配。"
    } else {
        Write-CheckFail ("原生模块 ABI 是 $AbiOutput，不是 Node 22 对应的 127。" +
            "如果之前用别的 Node 版本执行过 npm install，node_modules 里的 better-sqlite3 是按那个版本编译的，" +
            "换回 Node 22 后会报 'NODE_MODULE_VERSION $AbiOutput does not match 127' 之类的错误。" +
            "修复方法：确认当前用的是 Node 22，然后重新安装依赖：" +
            "cd `"$ProjectRoot`"; Remove-Item -Recurse -Force node_modules; npm install")
    }

    $NpmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($NpmCmd) {
        Write-CheckOk "找到 npm：$($NpmCmd.Source)"
    } else {
        Write-CheckFail "未找到 npm（通常和 Node.js 一起安装，请检查 Node.js 安装是否完整）。"
    }
}
Write-Host ""

# ---- 2. node_modules / better-sqlite3 ----
$NodeModulesPath = Join-Path $ProjectRoot 'node_modules'
if (Test-Path $NodeModulesPath) {
    Write-CheckOk "node_modules 目录存在。"
} else {
    Write-CheckFail "node_modules 目录不存在。修复方法：cd `"$ProjectRoot`"; npm install"
}

if ($NodeCmd -and (Test-Path $NodeModulesPath)) {
    $probeScript = "try { require('better-sqlite3'); process.stdout.write('OK'); } catch (e) { process.stdout.write('FAIL:' + e.message); process.exitCode = 1; }"
    Push-Location $ProjectRoot
    try {
        $sqliteProbe = & node -e $probeScript 2>&1
    } finally {
        Pop-Location
    }
    if ($sqliteProbe -match '^OK') {
        Write-CheckOk "better-sqlite3 原生模块可以正常加载。"
    } else {
        Write-CheckFail ("better-sqlite3 加载失败：$sqliteProbe 。" +
            "最常见原因是 NODE_MODULE_VERSION 不匹配（node_modules 是用别的 Node 版本装的）。" +
            "修复方法：确认当前是 Node 22，然后：cd `"$ProjectRoot`"; Remove-Item -Recurse -Force node_modules; npm install")
    }
}
Write-Host ""

# ---- 3. 配置文件 ----
$SitesCsv = Join-Path $ProjectRoot 'config\sites.csv'
if (Test-Path $SitesCsv) {
    Write-CheckOk "config\sites.csv 存在。"
} else {
    Write-CheckFail "config\sites.csv 不存在——这是必需的站点清单文件，面板无法在没有它的情况下正常工作。"
}
$SiteLimitsCsv = Join-Path $ProjectRoot 'config\site-limits.csv'
if (Test-Path $SiteLimitsCsv) {
    Write-CheckOk "config\site-limits.csv 存在（可选的站点级限制覆盖）。"
} else {
    Write-Host "[信息] config\site-limits.csv 不存在——这是可选文件，不存在时等同于没有任何站点覆盖，不影响正常使用。"
}
$SiteSitemapsCsv = Join-Path $ProjectRoot 'config\site-sitemaps.csv'
if (Test-Path $SiteSitemapsCsv) {
    Write-CheckOk "config\site-sitemaps.csv 存在（可选的手工 Sitemap 配置）。"
} else {
    Write-Host "[信息] config\site-sitemaps.csv 不存在——这是可选文件，不影响正常使用。"
}
Write-Host ""

# ---- 4. 数据库 ----
$DbPath = Join-Path $ProjectRoot 'data\local.db'
if (Test-Path $DbPath) {
    Write-CheckOk "data\local.db 存在。"
    if ($NodeCmd) {
        # 只读方式打开数据库做完整性检查，绝不触发迁移写入，也绝不修改任何数据。
        $integrityScript = "const Database = require('better-sqlite3'); const db = new Database(process.argv[1], { readonly: true, fileMustExist: true }); const result = db.pragma('integrity_check', { simple: true }); process.stdout.write(String(result)); db.close();"
        Push-Location $ProjectRoot
        try {
            $integrityResult = & node -e $integrityScript -- $DbPath 2>&1
        } finally {
            Pop-Location
        }
        if ($integrityResult -eq 'ok') {
            Write-CheckOk "SQLite 完整性检查（PRAGMA integrity_check）通过。"
        } else {
            Write-CheckFail "SQLite 完整性检查未通过：$integrityResult 。数据库文件可能已损坏，建议从 backups\ 目录恢复最近一次备份（见 restore-local-data.ps1）。"
        }
    }
} else {
    Write-Host "[信息] data\local.db 不存在——首次运行前属于正常情况，启动面板或执行采集时会自动创建。"
}
Write-Host ""

# ---- 5. output 目录可写 ----
$OutputDir = Join-Path $ProjectRoot 'output'
if (-not (Test-Path $OutputDir)) {
    try {
        New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    } catch {
        Write-CheckFail "output 目录不存在且无法创建：$($_.Exception.Message)"
    }
}
if (Test-Path $OutputDir) {
    $ProbeFile = Join-Path $OutputDir '.check-installation-probe.tmp'
    try {
        Set-Content -Path $ProbeFile -Value 'probe' -Encoding UTF8 -ErrorAction Stop
        Remove-Item -Path $ProbeFile -Force -ErrorAction Stop
        Write-CheckOk "output 目录可写。"
    } catch {
        Write-CheckFail "output 目录不可写：$($_.Exception.Message)"
    }
}
Write-Host ""

# ---- 6. 端口 8766 ----
$Port = 8766
if ($env:SITEMAP_DASHBOARD_PORT) {
    $Port = [int]$env:SITEMAP_DASHBOARD_PORT
}
$TcpTest = $null
try {
    $TcpClient = New-Object System.Net.Sockets.TcpClient
    $ConnectTask = $TcpClient.ConnectAsync('127.0.0.1', $Port)
    $TcpTest = $ConnectTask.Wait(1000)
    $TcpClient.Close()
} catch {
    $TcpTest = $false
}
if (-not $TcpTest) {
    Write-CheckOk "端口 $Port 空闲，可以正常启动面板。"
} else {
    try {
        $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3 -Headers @{ Host = "127.0.0.1:$Port" }
        $envelope = $health.Content | ConvertFrom-Json
        if ($envelope.data -and $envelope.data.service -eq 'sitemap-dashboard') {
            Write-Host "[信息] 端口 $Port 上已经在运行本项目的面板服务（pid=$($envelope.data.pid)），无需重复启动。"
        } else {
            Write-CheckWarn "端口 $Port 已被占用，但不是本项目的面板服务。启动面板前请先释放该端口，或设置环境变量 SITEMAP_DASHBOARD_PORT 使用其它端口。"
        }
    } catch {
        Write-CheckWarn "端口 $Port 已被占用，且无法确认是什么程序在使用。启动面板前请先释放该端口，或设置环境变量 SITEMAP_DASHBOARD_PORT 使用其它端口。"
    }
}
Write-Host ""

# ---- 7. 启动/停止脚本 ----
foreach ($script in @('start-dashboard.ps1', 'stop-dashboard.ps1')) {
    $scriptPath = Join-Path $PSScriptRoot $script
    if (Test-Path $scriptPath) {
        Write-CheckOk "$script 存在。"
    } else {
        Write-CheckFail "$script 不存在，无法通过标准方式启动/停止面板。"
    }
}
Write-Host ""

Write-Host "===================================================="
if ($script:FailCount -eq 0 -and $script:WarnCount -eq 0) {
    Write-Host "体检结果：全部通过。" -ForegroundColor Green
} elseif ($script:FailCount -eq 0) {
    Write-Host "体检结果：$($script:WarnCount) 项警告，没有阻断性错误。" -ForegroundColor Yellow
} else {
    Write-Host "体检结果：$($script:FailCount) 项错误，$($script:WarnCount) 项警告。请先按上面的修复命令处理错误项。" -ForegroundColor Red
}
Write-Host "===================================================="

if ($script:FailCount -gt 0) {
    exit 1
}
exit 0
