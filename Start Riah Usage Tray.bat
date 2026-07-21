@echo off
REM Double-click to bring back the tray icon by the clock (if you quit it).
REM The desk itself is separate: "Start Riah Usage.bat" starts everything.
cd /d "%~dp0"
wscript.exe //B //Nologo "%~dp0tray\tray-hidden.vbs"
exit /b 0
