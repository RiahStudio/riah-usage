@echo off
REM Double-click to start Riah Usage: the desk (your meters) and the tray icon.
REM Safe to run any time; it skips whatever is already running.
REM
REM All the logic is in tray\start-riah-usage.ps1 -- NOT inline here. A previous
REM version put a for-loop and parenthesised blocks in this .bat to hunt for
REM Node, and Windows batch mangled it into executing fragments of its own text.
REM One file, one language.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tray\start-riah-usage.ps1"
exit /b %errorlevel%
