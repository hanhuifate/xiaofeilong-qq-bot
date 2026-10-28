$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$runner = Join-Path $taskRoot 'run-astrbot.py'
$existing = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($runner) }
if ($existing) { Write-Output 'AstrBot is already running.'; exit 0 }
$python = Join-Path $env:USERPROFILE '.dafeilong-runtime\astrbot-venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'AstrBot isolated Python environment is missing.' }
& $python (Join-Path $taskRoot 'setup-astrbot.py')
if ($LASTEXITCODE -ne 0) { throw 'AstrBot profile setup failed.' }
$logs = Join-Path $taskRoot 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$process = Start-Process -FilePath $python -ArgumentList @('"' + $runner + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'astrbot.log') -RedirectStandardError (Join-Path $logs 'astrbot-error.log') -PassThru
@{ pid=$process.Id; startedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot 'data\astrbot-process.json') -Encoding UTF8
Write-Output "AstrBot started. PID: $($process.Id)"
