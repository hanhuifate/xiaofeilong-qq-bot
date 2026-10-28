$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'QQ-Risk-Control.ps1')
$risk = Get-QQRiskState -Root $PSScriptRoot
if ($risk.paused) {
    Write-Output ('QQ risk control is active; the login page is blocked. Complete official QQ verification first. ' + $risk.reason)
    exit 3
}
$settings = Join-Path $PSScriptRoot 'runtime\napcat\config\webui.json'
$config = Get-Content -LiteralPath $settings -Encoding UTF8 -Raw | ConvertFrom-Json
if (-not $config.token -or -not $config.port) { throw 'NapCat login settings are incomplete.' }
$page = 'http://127.0.0.1:' + [int]$config.port + '/webui/web_login?token=' + [uri]::EscapeDataString([string]$config.token)
# Supported local WebUI login route; never print its credential-bearing URL.
Start-Process $page
Write-Output 'Local QQ login page opened. The access key stays on this computer.'
