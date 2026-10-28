$ErrorActionPreference = 'Stop'
$status = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'status.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if (-not $status.viewerPort -or $status.state -eq 'stopped') { throw 'Please start the QQ bridge first.' }
$viewerToken = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'data\viewer-token.txt') -Encoding UTF8 -Raw).Trim()
Start-Process "http://127.0.0.1:$($status.viewerPort)/#$viewerToken"
