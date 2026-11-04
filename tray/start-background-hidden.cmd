@echo off
setlocal
cd /d "%~dp0.."
if not exist scratch mkdir scratch
set "PATH=%ProgramFiles%\nodejs;%LocalAppData%\Programs\node;C:\nvm4w\nodejs;%PATH%"
if not defined RIAH_USAGE_PORT set "RIAH_USAGE_PORT=8800"
REM Not desk.log: the server's wrapper appends there, and a cmd >> redirect
REM refuses a second writer, so sharing one log kept the desk from starting.
node start-background.js >> scratch\desk-launcher.log 2>&1
exit /b %errorlevel%