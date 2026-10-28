$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-astrbot.py'
$processes = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($runner) }
$ids = @($processes | Select-Object -ExpandProperty ProcessId)
foreach ($process in @($processes | Where-Object { $_.ParentProcessId -notin $ids })) { & taskkill.exe /PID $process.ProcessId /T /F | Out-Null }
Write-Output 'AstrBot local host stopped; QQ login is unchanged.'
