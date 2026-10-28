@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-ChatGPT-Images.ps1"
if errorlevel 1 pause
if not exist "%~dp0data\chatgpt-image-browser.json" pause
