$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$doubaoRoot = Join-Path $taskRoot 'runtime\autodoubao'
$python = Join-Path $doubaoRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Doubao image runtime is missing.' }
$running = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($doubaoRoot) -and $_.CommandLine -like '*serve*' }
if (-not $running) {
    $data = Join-Path $doubaoRoot 'data'
    Start-Process -FilePath $python -ArgumentList @('-m','autodoubao','--config','config.yaml','serve') -WorkingDirectory $doubaoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'service.stdout.log') -RedirectStandardError (Join-Path $data 'service.stderr.log') | Out-Null
}
& (Join-Path $taskRoot 'Manage-Doubao-Browser.ps1') -Action Ensure | Out-Null
