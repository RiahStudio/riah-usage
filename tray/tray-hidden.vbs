' Start the tray through a hidden batch wrapper so PowerShell inherits no visible console.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
cmd = """" & dir & "\start-tray-hidden.cmd" & """"
sh.Run cmd, 0, False
