@echo off
start "" "%SystemRoot%\System32\wscript.exe" //nologo "%~dp0Run-Hidden.vbs" Control-Panel.ps1
exit /b
