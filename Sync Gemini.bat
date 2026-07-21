@echo off
setlocal
title Riah Usage Sync Gemini
cd /d "%~dp0"

echo.
echo  Riah Usage - Sync Gemini
echo  A browser window will open.
echo  Sign into Google only if asked - that login is saved for next time.
echo.

set "NODE_BIN="
if defined NODE_EXE if exist "%NODE_EXE%" set "NODE_BIN=%NODE_EXE%"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%LocalAppData%\Programs\node\node.exe" set "NODE_BIN=%LocalAppData%\Programs\node\node.exe"
if not defined NODE_BIN (
  where node >nul 2>&1
  if not errorlevel 1 for /f "delims=" %%i in ('where node') do (
    if not defined NODE_BIN set "NODE_BIN=%%i"
  )
)

if not defined NODE_BIN (
  echo  Could not find Node on this machine.
  echo  If Riah Usage is already open, use Sync from Connect there instead.
  echo.
  pause
  exit /b 1
)

"%NODE_BIN%" sync-gemini.js
set EXITCODE=%ERRORLEVEL%
echo.
if %EXITCODE% neq 0 (
  echo  Sync did not finish cleanly. You can run this again.
) else (
  echo  Done. Back in Riah Usage, tap Check again.
)
echo.
echo  Press any key to close...
pause >nul
exit /b %EXITCODE%
