<#
  关闭 hikctl。
  先调 POST /api/shutdown 优雅退出（会清理 runtime.json、关闭端口）；
  万一失败再按 PID 兜底结束进程。
  由 hikctl-stop.cmd / 桌面快捷方式「hikctl 关闭」调用。
#>
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$runtimeFile = Join-Path $root 'data\runtime.json'

if (-not (Test-Path $runtimeFile)) {
  Write-Host ''
  Write-Host '  hikctl 当前没有在运行。' -ForegroundColor Yellow
  Write-Host ''
  Start-Sleep -Seconds 2
  exit 0
}

try { $r = Get-Content $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $r = $null }
$port = if ($r -and $r.port) { $r.port } else { 8787 }
$pid_ = if ($r) { $r.pid } else { 0 }

Write-Host ''
Write-Host "  正在关闭 hikctl（端口 $port）…" -ForegroundColor Cyan

# 1) 优雅关闭
try { Invoke-RestMethod "http://127.0.0.1:$port/api/shutdown" -Method Post -TimeoutSec 5 | Out-Null } catch { }

# 2) 等它自己退出（成功退出会删掉 runtime.json）
for ($i = 0; $i -lt 32; $i++) {
  Start-Sleep -Milliseconds 250
  if (-not (Test-Path $runtimeFile)) { break }
}

# 3) 兜底：按 PID 结束
if (Test-Path $runtimeFile) {
  if ($pid_ -and $pid_ -gt 0) { Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 600
  Remove-Item $runtimeFile -Force -ErrorAction SilentlyContinue
}

# 4) 复核
$alive = $false
try { Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 2 | Out-Null; $alive = $true } catch { }

Write-Host ''
if ($alive) {
  Write-Host '  [警告] 仍有进程在监听，请手动结束 node 进程。' -ForegroundColor Red
} else {
  Write-Host '  hikctl 已关闭。' -ForegroundColor Green
}
Write-Host ''
Start-Sleep -Seconds 2
exit 0