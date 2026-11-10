<#
  启动 hikctl（后台运行，不占用命令行窗口）。
  已在运行则直接打开界面。
  由 hikctl-start.cmd / 桌面快捷方式「hikctl 启动」调用。
#>
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot          # …\hikctl
$runtimeFile = Join-Path $root 'data\runtime.json'

function Get-Running {
  if (-not (Test-Path $runtimeFile)) { return $null }
  try { $r = Get-Content $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  if (-not $r.port) { return $null }
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$($r.port)/api/health" -TimeoutSec 2
    if ($h.ok) { return $r }
  } catch { }
  return $null
}

function Show-Info($r) {
  Write-Host ''
  Write-Host '  hikctl 已就绪' -ForegroundColor Green
  Write-Host "  控制台   : http://127.0.0.1:$($r.port)/"
  if ($r.consolePort) { Write-Host "  WEB 后台 : http://127.0.0.1:$($r.consolePort)/" }
  Write-Host ''
  Write-Host '  关闭：双击桌面上的「hikctl 关闭」' -ForegroundColor DarkGray
  Write-Host ''
}

$run = Get-Running
if ($run) {
  Write-Host ''
  Write-Host '  hikctl 已经在运行，直接打开界面…' -ForegroundColor Yellow
  Show-Info $run
  Start-Process "http://127.0.0.1:$($run.port)/"
  Start-Sleep -Seconds 2
  exit 0
}

# 检查 Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ''
  Write-Host '  [错误] 未找到 Node.js，本程序需要 Node.js 20 或更高版本。' -ForegroundColor Red
  Write-Host '         下载地址：https://nodejs.org/'
  Write-Host ''
  Read-Host '按回车关闭'
  exit 1
}

Write-Host ''
Write-Host '  正在启动 hikctl …' -ForegroundColor Cyan
Start-Process -FilePath 'node' -ArgumentList 'src/main.js', '--no-open' `
  -WorkingDirectory $root -WindowStyle Hidden

$run = $null
for ($i = 0; $i -lt 80; $i++) {          # 最多等 20 秒
  Start-Sleep -Milliseconds 250
  $run = Get-Running
  if ($run) { break }
}

if (-not $run) {
  Write-Host ''
  Write-Host '  [错误] 启动失败或超时。' -ForegroundColor Red
  Write-Host "  请在命令行里手动运行以查看报错："
  Write-Host "      cd /d `"$root`""
  Write-Host '      node src\main.js'
  Write-Host ''
  Read-Host '按回车关闭'
  exit 1
}

Show-Info $run
Start-Process "http://127.0.0.1:$($run.port)/"
Start-Sleep -Seconds 2
exit 0