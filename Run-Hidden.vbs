Option Explicit
Dim fs, shell, root, target, name, command, i, exitCode, log
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count = 0 Then WScript.Quit 2
name = fs.GetFileName(WScript.Arguments(0))
Select Case LCase(name)
  Case "control-panel.ps1", "view-sessions.ps1", "local-features-panel.ps1", "qq-account-panel.ps1", "supervise.ps1", "start.ps1", "stop.ps1"
  Case Else: WScript.Quit 2
End Select
target = fs.BuildPath(root, name)
If Not fs.FileExists(target) Then WScript.Quit 2
If LCase(name) = "supervise.ps1" Then
  If WScript.Arguments.Count <> 3 Then WScript.Quit 2
  If WScript.Arguments(1) <> "-Component" Then WScript.Quit 2
  Select Case WScript.Arguments(2)
    Case "core", "qq", "doubao"
    Case Else: WScript.Quit 2
  End Select
ElseIf WScript.Arguments.Count <> 1 Then
  WScript.Quit 2
End If
shell.CurrentDirectory = root
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe") & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File """ & target & """"
For i = 1 To WScript.Arguments.Count - 1
  command = command & " """ & WScript.Arguments(i) & """"
Next
On Error Resume Next
' Waiting keeps a Scheduled Task alive for the whole supervisor lifetime, so
' IgnoreNew continues to prevent duplicate background services.
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  If Not fs.FolderExists(fs.BuildPath(root, "logs")) Then fs.CreateFolder fs.BuildPath(root, "logs")
  Set log = fs.OpenTextFile(fs.BuildPath(root, "logs\hidden-launcher-error.log"), 8, True, -1)
  log.WriteLine CStr(Now) & " " & name & " " & Err.Description
  log.Close
  WScript.Quit 1
End If
WScript.Quit exitCode
