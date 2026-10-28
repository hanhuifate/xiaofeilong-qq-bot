$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
. (Join-Path $taskRoot 'QQ-Risk-Control.ps1')
$risk = Get-QQRiskState -Root $taskRoot
if ($risk.paused) { Write-Output ('QQ risk control is active; automatic login blocked. ' + $risk.reason); exit 0 }
$taskCfg = Get-Content -LiteralPath (Join-Path $taskRoot 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$launchMutex = New-Object System.Threading.Mutex($false, ('Local\DafeilongQQ-' + $taskCfg.botQQ))
$lockTaken = $false
try {
try { $lockTaken = $launchMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $lockTaken = $true }
if (-not $lockTaken) { exit 0 }
if (Get-NetTCPConnection -LocalPort ([uri]$taskCfg.onebotUrl).Port -State Listen -ErrorAction SilentlyContinue) { exit 0 }
$napcat = Join-Path $taskRoot 'runtime\napcat'
$launchPath = Join-Path $napcat 'NapCatWinBootMain.exe'
if (-not (Test-Path -LiteralPath $launchPath) -or -not (Test-Path -LiteralPath $taskCfg.qqPath)) { throw 'QQ adapter runtime is missing.' }
# OneBot starts only AFTER QQ login. An existing launcher awaiting verification
# is healthy enough to keep; never create another login every supervisor tick.
$accountPattern = '(?:^|\s)-q\s+' + [regex]::Escape($taskCfg.botQQ) + '(?:\s|$)'
$existing = Get-CimInstance Win32_Process -Filter "Name='NapCatWinBootMain.exe'" | Where-Object {
    $_.ExecutablePath -eq $launchPath -and $_.CommandLine -match $accountPattern
} | Select-Object -First 1
if ($existing) {
    $retryStorm = $false
    $processRecord = Join-Path $taskRoot 'napcat-process.json'
    if (Test-Path -LiteralPath $processRecord) {
        try {
            $previous = Get-Content -LiteralPath $processRecord -Encoding UTF8 -Raw | ConvertFrom-Json
            if ((-not $previous.botQQ -or $previous.botQQ -eq $taskCfg.botQQ) -and $previous.startedAt) {
                $retryStorm = Test-QQRetryStorm -Root $taskRoot -Since ([DateTime]::Parse($previous.startedAt))
            }
        } catch {}
    }
    if ($retryStorm) {
        & (Join-Path $taskRoot 'Set-QQ-Risk-Control.ps1') -Action Pause -Reason '检测到同一登录流程连续生成多个二维码，已自动停止重试，避免加重 QQ 风控。'
        Write-Output 'Repeated QR retries detected; QQ risk pause enabled.'
        exit 0
    }
    Write-Output 'QQ adapter process exists; waiting for its login or verification. No duplicate started.'
    exit 0
}
$processRecord = Join-Path $taskRoot 'napcat-process.json'
if (Test-Path -LiteralPath $processRecord) {
    try {
        $previous = Get-Content -LiteralPath $processRecord -Encoding UTF8 -Raw | ConvertFrom-Json
        $age = ((Get-Date) - [DateTime]::Parse($previous.startedAt)).TotalSeconds
        if ((-not $previous.botQQ -or $previous.botQQ -eq $taskCfg.botQQ) -and $age -ge 0 -and $age -lt 120) { Write-Output 'QQ adapter startup cooldown; no repeated login attempt.'; exit 0 }
    } catch { }
}
$logs = Join-Path $taskRoot 'logs'
$env:NAPCAT_PATCH_PACKAGE = Join-Path $napcat 'qqnt.json'
$env:NAPCAT_LOAD_PATH = Join-Path $napcat 'loadNapCat.js'
$env:NAPCAT_INJECT_PATH = Join-Path $napcat 'NapCatWinBootHook.dll'
$env:NAPCAT_MAIN_PATH = Join-Path $napcat 'napcat.mjs'
$launcher = Start-Process -FilePath $launchPath -ArgumentList @('"' + $taskCfg.qqPath + '"', '"' + $env:NAPCAT_INJECT_PATH + '"', '-q', $taskCfg.botQQ) -WorkingDirectory $napcat -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'napcat.log') -RedirectStandardError (Join-Path $logs 'napcat-error.log') -PassThru
@{ launcherPid=$launcher.Id; botQQ=$taskCfg.botQQ; startedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot 'napcat-process.json') -Encoding UTF8
} finally {
    if ($lockTaken) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}
