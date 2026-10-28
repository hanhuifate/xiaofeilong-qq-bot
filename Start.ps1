param([switch]$BridgeOnly,[switch]$ServiceChild)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
. (Join-Path $taskRoot 'QQ-Risk-Control.ps1')
$risk = Get-QQRiskState -Root $taskRoot
if ($risk.paused) {
    Write-Output ('QQ risk control is active; service start blocked. ' + $risk.reason)
    exit 0
}
$taskCfg = Get-Content -LiteralPath (Join-Path $taskRoot 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if (-not $ServiceChild -and (Test-Path -LiteralPath (Join-Path $taskRoot 'data\service-tasks.json'))) {
    $tasks = Get-Content -LiteralPath (Join-Path $taskRoot 'data\service-tasks.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @($tasks.qq,$tasks.doubao,$tasks.core)) { if ($name) { Start-ScheduledTask -TaskName $name } }
    Write-Output 'Start requested through independent local supervisors.'
    exit 0
}
if ($taskCfg.framework -and $taskCfg.framework.enabled) { & (Join-Path $taskRoot 'Start-AstrBot.ps1') }
$logDir = Join-Path $taskRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$doubaoRoot = Join-Path $taskRoot 'runtime\autodoubao'
$doubaoPython = Join-Path $doubaoRoot '.venv\Scripts\python.exe'
if (-not $ServiceChild -and (Test-Path -LiteralPath $doubaoPython) -and (Test-Path -LiteralPath (Join-Path $doubaoRoot 'config.yaml'))) {
    $doubaoRunning = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq 'python.exe' -and $_.CommandLine -like '*autodoubao*' -and $_.CommandLine -like '*serve*'
    }
    if (-not $doubaoRunning) {
        $doubaoData = Join-Path $doubaoRoot 'data'
        New-Item -ItemType Directory -Path $doubaoData -Force | Out-Null
        Start-Process -FilePath $doubaoPython -ArgumentList @('-m', 'autodoubao', '--config', 'config.yaml', 'serve') `
          -WorkingDirectory $doubaoRoot -WindowStyle Hidden `
          -RedirectStandardOutput (Join-Path $doubaoData 'service.stdout.log') `
          -RedirectStandardError (Join-Path $doubaoData 'service.stderr.log') | Out-Null
        Write-Output 'Doubao image bridge started.'
    }
    $doubaoBrowserManager = Join-Path $taskRoot 'Manage-Doubao-Browser.ps1'
    if (Test-Path -LiteralPath $doubaoBrowserManager) {
        & $doubaoBrowserManager -Action Ensure | Out-Null
    }
}
$statusPath = Join-Path $taskRoot 'status.json'
$bridgeRunning = $false
if (Test-Path -LiteralPath $statusPath) {
    try {
        $old = Get-Content -LiteralPath $statusPath -Encoding UTF8 -Raw | ConvertFrom-Json
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.pid)" -ErrorAction SilentlyContinue
        $bridgeRunning = $existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine.Contains((Join-Path $taskRoot 'bridge.mjs'))
    } catch { }
}
if (-not $bridgeRunning) {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $bridge = Start-Process -FilePath $nodePath -ArgumentList @('"' + (Join-Path $taskRoot 'bridge.mjs') + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'bridge.log') -RedirectStandardError (Join-Path $logDir 'bridge-error.log') -PassThru
    Write-Output "Bridge started. PID: $($bridge.Id)"
} else { Write-Output 'Bridge is already running.' }
if ($BridgeOnly) { exit 0 }
& (Join-Path $taskRoot 'Start-QQ.ps1')
