$ErrorActionPreference = 'Stop'
$tasksFile = Join-Path $PSScriptRoot 'data\service-tasks.json'
if (Test-Path -LiteralPath $tasksFile) {
    $tasks = Get-Content -LiteralPath $tasksFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($tasks.core) { Stop-ScheduledTask -TaskName $tasks.core -ErrorAction SilentlyContinue }
}
$statusPath = Join-Path $PSScriptRoot 'status.json'
if (-not (Test-Path -LiteralPath $statusPath)) { Write-Output 'Bridge is not running.'; exit 0 }
$status = Get-Content -LiteralPath $statusPath -Encoding UTF8 -Raw | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($status.pid)" -ErrorAction SilentlyContinue
if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine.Contains((Join-Path $PSScriptRoot 'bridge.mjs'))) {
    # Stop this bridge and its active Codex child only. Leave ordinary QQ sessions alone.
    & taskkill.exe /PID $status.pid /T /F | Out-Null
    $status.state = 'stopped'
    $status | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusPath -Encoding utf8
    Write-Output 'Group replies stopped.'
} else { Write-Output 'Bridge is not running.' }
