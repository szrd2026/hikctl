@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 未找到 Node.js。本工具需要 Node.js 20 或更高版本。
  echo   下载地址: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo.
echo   hikctl  启动中...  (Node !NODEV!)
node src\main.js %*
if errorlevel 1 pause
endlocal