@echo off
setlocal
cd /d "%~dp0.."
if not exist scratch mkdir scratch
if not defined RIAH_USAGE_PORT set "RIAH_USAGE_PORT=8800"
set "RIAH_USAGE_BACKGROUND=1"
if defined RIAH_USAGE_NODE_EXE (
  "%RIAH_USAGE_NODE_EXE%" serve.js >> scratch\desk.log 2>&1
) else (
  node serve.js >> scratch\desk.log 2>&1
)
exit /b %errorlevel%