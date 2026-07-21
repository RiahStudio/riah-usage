@echo off
REM Double-click to restart the tray icon: stops the old one, PROVES it
REM stopped, then starts a fresh one. All logic lives in
REM tray\restart-tray.ps1 -- one file, one language.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tray\restart-tray.ps1"
pause
exit /b %errorlevel%
