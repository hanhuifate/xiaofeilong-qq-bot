param(
  [ValidateSet('Ensure', 'Start', 'Stop', 'Restart', 'Status')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime\autodoubao'
$profile = Join-Path $runtime 'chrome-profile'
$extension = Join-Path $runtime 'extension'
$stateFile = Join-Path $root 'data\doubao-browser.json'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

function Read-State {
  if (Test-Path -LiteralPath $stateFile) {
    try { return Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  }
  return [pscustomobject]@{ enabled = $true }
}
function Save-State([bool]$enabled) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stateFile) | Out-Null
  [pscustomobject]@{ enabled = $enabled; updatedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding utf8
}
function Get-DoubaoChrome {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'chrome.exe' -and $_.CommandLine -like "*$profile*" -and $_.CommandLine -notmatch '\s--type='
  }
}
function Start-DoubaoChrome {
  if (Get-DoubaoChrome) { return }
  if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome was not found.' }
  if (-not (Test-Path -LiteralPath $extension)) { throw 'AutoDoubao extension is missing.' }
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  Start-Process -FilePath $chrome -ArgumentList @(
    "--user-data-dir=$profile", "--load-extension=$extension", '--start-minimized',
    '--no-first-run', '--disable-session-crashed-bubble', 'https://www.doubao.com/chat/'
  ) -WindowStyle Minimized | Out-Null
}
function Stop-DoubaoChrome {
  foreach ($process in @(Get-DoubaoChrome)) {
    if ($process.ProcessId -and $process.CommandLine -like "*$profile*") {
      & taskkill.exe /PID $process.ProcessId /T /F | Out-Null
    }
  }
}

if ($Action -eq 'Start') { Save-State $true; Start-DoubaoChrome }
elseif ($Action -eq 'Stop') { Save-State $false; Stop-DoubaoChrome }
elseif ($Action -eq 'Restart') { Save-State $true; Stop-DoubaoChrome; Start-Sleep -Milliseconds 400; Start-DoubaoChrome }
elseif ($Action -eq 'Ensure') { if ((Read-State).enabled -ne $false) { Start-DoubaoChrome } }

$state = Read-State
$process = @(Get-DoubaoChrome | Select-Object -First 1)
[pscustomobject]@{
  enabled = ($state.enabled -ne $false)
  running = ($process.Count -gt 0)
  pid = if ($process.Count) { $process[0].ProcessId } else { $null }
} | ConvertTo-Json -Compress
