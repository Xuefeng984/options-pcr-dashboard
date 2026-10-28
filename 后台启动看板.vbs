' Start the PCR dashboard with no console window.
' Double-click this file, or put a shortcut to it in the Windows Startup folder
' (Win+R -> shell:startup) so it starts automatically at logon.
Option Explicit
Dim fso, sh, base, pyw, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
pyw = "pythonw.exe"
' If pythonw.exe is not on PATH, uncomment the next line and set an absolute path.
' pyw = "C:\Python311\pythonw.exe"
cmd = """" & pyw & """ """ & base & "\serve.py"" --port 8788"
sh.Run cmd, 0, False
