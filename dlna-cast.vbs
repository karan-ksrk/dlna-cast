' Starts the dlna-cast app with no console window. Output goes to %LOCALAPPDATA%\dlna-cast\app.log.
' Closing the app window stops casting and quits. The desktop shortcut points here.
Option Explicit
Dim shell, fso, appDir, logDir, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\dlna-cast"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

' "where node" fails when Node.js isn't on PATH; say so instead of failing silently.
exitCode = shell.Run("cmd /c where node >nul 2>&1", 0, True)
If exitCode <> 0 Then
  MsgBox "dlna-cast needs Node.js, but ""node"" isn't on your PATH." & vbCrLf & _
         "Install Node.js 18 or newer, then try again.", vbExclamation, "dlna-cast"
  WScript.Quit 1
End If

shell.CurrentDirectory = appDir
' Window style 0 runs node hidden. If the app is already running, this just opens its window again.
command = "node """ & appDir & "\src\cli.mjs"" gui --log """ & logDir & "\app.log"""
shell.Run command, 0, False
