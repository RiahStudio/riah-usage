' Start Riah Usage with no console window left open.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
' Hidden cmd so PATH can include common Node installs without a visible window.
cmd = "cmd /c ""set ""PATH=%ProgramFiles%\nodejs;%LocalAppData%\Programs\node;C:\nvm4w\nodejs;%PATH%"" && node start-background.js"""
sh.Run cmd, 0, False
