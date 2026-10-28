@echo off
start "" "%SystemRoot%\System32\wscript.exe" //nologo "%~dp0Run-Hidden.vbs" View-Sessions.ps1
exit /b
