' Start the Riah Usage tray icon with no console window.
' IMPORTANT: -File must be a fully-quoted absolute path (folder has spaces).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
script = dir & "\riah-usage-tray.ps1"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File """ & script & """"
sh.Run cmd, 0, False
