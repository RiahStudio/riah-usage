@echo off
setlocal
cd /d "%~dp0"
REM Stop the background desk (if running). Safe if it is already stopped.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=8775; $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }; $pidFile=Join-Path '%~dp0' 'scratch\desk.pid'; if (Test-Path $pidFile) { $raw=Get-Content $pidFile -ErrorAction SilentlyContinue; if ($raw) { Stop-Process -Id ([int]$raw) -Force -ErrorAction SilentlyContinue }; Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }"
exit /b 0
