$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
$botRoot = $PSScriptRoot
$serviceRoot = Join-Path $botRoot 'runtime\autodoubao'
$python = Join-Path $serviceRoot '.venv\Scripts\python.exe'
$extension = Join-Path $serviceRoot 'extension'
$profile = Join-Path $serviceRoot 'chrome-profile'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $extension)) {
    throw 'Doubao image component is incomplete.'
}
if (-not (Test-Path -LiteralPath $chrome)) { throw 'Google Chrome was not found.' }

# This token only authenticates the loopback extension bridge. Keep it out of logs.
Push-Location -LiteralPath $serviceRoot
try { $token = & $python -m autodoubao --config config.yaml show-token }
finally { Pop-Location }
if (-not $token) { throw 'Could not read the local extension token.' }
Set-Clipboard -Value $token
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Start-Process -FilePath $chrome -ArgumentList @("--user-data-dir=$profile", "--load-extension=$extension", 'https://www.doubao.com/chat/')
Start-Process -FilePath $chrome -ArgumentList @("--user-data-dir=$profile", 'chrome://extensions/')
[System.Windows.MessageBox]::Show(
  "An isolated Chrome profile is open and the local-only extension token is in the clipboard. In chrome://extensions, enable Developer mode, click Load unpacked, and select the extension folder. Then open AutoDoubao options, paste the token, and sign in to Doubao. Do not send the token in QQ.",
  'Doubao image setup'
) | Out-Null
