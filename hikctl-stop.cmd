@echo off
chcp 65001 >nul
rem hikctl STOP - gracefully stops the background service.
rem Desktop shortcut points here. Keep this file ASCII-only (cmd codepage safety).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop.ps1"
exit /b %errorlevel%