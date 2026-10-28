@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0Open-Doubao-Image-Setup.ps1"
if errorlevel 1 (
  echo.
  echo 豆包生图设置未能启动。上方显示了原因。
  pause
)
