param([Parameter(Mandatory=$true)][ValidateSet('core','qq','doubao')][string]$Component)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$supervisorProcessId = [System.Diagnostics.Process]::GetCurrentProcess().Id
@{ pid=$supervisorProcessId; component=$Component; startedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot "data\supervisor-$Component.json") -Encoding UTF8
while ($true) {
    try {
        if ($Component -eq 'core') {
            $coreConfig = Get-Content -LiteralPath (Join-Path $taskRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($coreConfig.llm -and $coreConfig.llm.type -eq 'openai_compatible') {
                $keyVariable = [string]$coreConfig.llm.apiKeyEnv
                if (-not $keyVariable) { $keyVariable = 'DFL_API_KEY' }
                if ($keyVariable -cmatch '^[A-Z][A-Z0-9_]{0,79}$') {
                    $keyValue = [Environment]::GetEnvironmentVariable($keyVariable,'User')
                    if ($keyValue) { [Environment]::SetEnvironmentVariable($keyVariable,$keyValue,'Process') }
                }
            }
            $statusPath = Join-Path $taskRoot 'status.json'
            if (Test-Path -LiteralPath $statusPath) {
                $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($status.updatedAt -and ((Get-Date).ToUniversalTime() - [DateTime]::Parse($status.updatedAt).ToUniversalTime()).TotalSeconds -gt 180) {
                    $stale = Get-CimInstance Win32_Process -Filter "ProcessId=$($status.pid)" -ErrorAction SilentlyContinue
                    if ($stale -and $stale.Name -eq 'node.exe' -and $stale.CommandLine.Contains((Join-Path $taskRoot 'bridge.mjs'))) { & taskkill.exe /PID $status.pid /T /F | Out-Null }
                }
            }
            & (Join-Path $taskRoot 'Start.ps1') -ServiceChild -BridgeOnly | Out-Null
        } elseif ($Component -eq 'qq') {
            & (Join-Path $taskRoot 'Start-QQ.ps1') | Out-Null
        } else {
            & (Join-Path $taskRoot 'Start-Doubao.ps1') | Out-Null
        }
    } catch {
        $entry = @{ at=(Get-Date).ToString('o'); component=$Component; error=$_.Exception.Message } | ConvertTo-Json -Compress
        $log = Join-Path $taskRoot 'logs\supervisor-errors.jsonl'
        Add-Content -LiteralPath $log -Value $entry -Encoding UTF8
    }
    Start-Sleep -Seconds 20
}
