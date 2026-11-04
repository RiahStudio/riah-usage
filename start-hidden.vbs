' Start Riah Usage through a hidden batch wrapper; VBS runs the .cmd at style 0.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
' The tray heals a dead desk through this file: bring it back on the studio's
' port (as autostart-logon.vbs does), not the standalone default 8800.
' serve.js still falls back to 8800 if Windows has reserved 8775.
Set env = sh.Environment("PROCESS")
If env("RIAH_USAGE_PORT") = "" Then env("RIAH_USAGE_PORT") = "8775"
env("RIAH_USAGE_NO_BROWSER") = "1"
cmd = """" & dir & "\tray\start-background-hidden.cmd" & """"
sh.Run cmd, 0, False
