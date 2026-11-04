@echo off
setlocal
cd /d "%~dp0"
if not defined RIAH_USAGE_PORT set "RIAH_USAGE_PORT=8800"
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0riah-usage-tray.ps1"
exit /b %errorlevel%