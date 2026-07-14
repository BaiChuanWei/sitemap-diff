# create-desktop-shortcuts.ps1
# 用途：在当前 Windows 用户的桌面创建两个快捷方式：
#   "Sitemap监控面板"   -> start-dashboard.ps1（只打开面板，不开始采集）
#   "运行Sitemap监控"   -> run-and-open-dashboard.ps1（启动/复用服务并打开面板）
#
# 重要：本脚本只能在真实 Windows + PowerShell 环境下创建和验证快捷方式。
# 在非 Windows 沙盒环境中执行会因为缺少 WScript.Shell COM 组件而失败，
# 这是预期行为，不代表脚本本身有问题——真实创建效果必须在本地 Windows
# 环境中人工验证（见 docs/dashboard-local-acceptance.md）。

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DesktopPath = [Environment]::GetFolderPath('Desktop')

if (-not (Test-Path $DesktopPath)) {
    Write-Host "错误：找不到桌面目录（$DesktopPath），无法创建快捷方式。" -ForegroundColor Red
    exit 1
}

$PowerShellExe = (Get-Command powershell.exe -ErrorAction SilentlyContinue)
if (-not $PowerShellExe) {
    $PowerShellExe = (Get-Command pwsh.exe -ErrorAction SilentlyContinue)
}
if (-not $PowerShellExe) {
    Write-Host '错误：找不到 powershell.exe 或 pwsh.exe，无法创建快捷方式。' -ForegroundColor Red
    exit 1
}

function New-DashboardShortcut {
    param(
        [string]$Name,
        [string]$TargetScript
    )
    $ShortcutPath = Join-Path $DesktopPath "$Name.lnk"
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $PowerShellExe.Source
    $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$TargetScript`""
    $Shortcut.WorkingDirectory = $ProjectRoot
    $Shortcut.IconLocation = "$($PowerShellExe.Source),0"
    $Shortcut.Save()
    Write-Host "已创建快捷方式：$ShortcutPath"
}

New-DashboardShortcut -Name 'Sitemap监控面板' -TargetScript (Join-Path $PSScriptRoot 'start-dashboard.ps1')
New-DashboardShortcut -Name '运行Sitemap监控' -TargetScript (Join-Path $PSScriptRoot 'run-and-open-dashboard.ps1')

Write-Host ''
Write-Host '桌面快捷方式创建完成。' -ForegroundColor Green
