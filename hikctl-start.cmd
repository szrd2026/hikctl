@echo off
chcp 65001 >nul
rem hikctl START - launches the background service and opens the console.
rem Desktop shortcut points here. Keep this file ASCII-only (cmd codepage safety).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start.ps1"
exit /b %errorlevel%