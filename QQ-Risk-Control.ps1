function Get-QQRiskState {
    param([Parameter(Mandatory = $true)][string]$Root)

    $path = Join-Path $Root 'data\qq-risk-state.json'
    if (-not (Test-Path -LiteralPath $path)) {
        return [pscustomobject]@{
            schemaVersion = 1
            paused = $false
            reason = ''
            source = 'default'
            pausedAt = $null
            resumedAt = $null
            updatedAt = $null
            error = $null
        }
    }
    try {
        $state = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $state.paused) { throw 'paused is missing' }
        return $state
    } catch {
        # Invalid safety state must fail closed.
        return [pscustomobject]@{
            schemaVersion = 1
            paused = $true
            reason = '风控暂停状态文件无效，已按安全模式停止自动登录。'
            source = 'invalid-state'
            pausedAt = $null
            resumedAt = $null
            updatedAt = (Get-Date).ToString('o')
            error = $_.Exception.Message
        }
    }
}

function Save-QQRiskState {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$State
    )

    $directory = Join-Path $Root 'data'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $path = Join-Path $directory 'qq-risk-state.json'
    $temp = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $path -Force
}

function Set-QQRiskState {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][ValidateSet('Pause', 'Resume')][string]$Action,
        [string]$Reason = '',
        [string]$Source = 'local'
    )

    $now = (Get-Date).ToString('o')
    if ($Action -eq 'Pause') {
        $reasonText = if ($Reason) { $Reason } else { 'QQ 风控安全暂停' }
        $state = [pscustomobject]@{
            schemaVersion = 1
            paused = $true
            reason = $reasonText
            source = $Source
            pausedAt = $now
            resumedAt = $null
            updatedAt = $now
            error = $null
        }
    } else {
        $current = Get-QQRiskState -Root $Root
        $state = [pscustomobject]@{
            schemaVersion = 1
            paused = $false
            reason = ''
            source = $Source
            pausedAt = $current.pausedAt
            resumedAt = $now
            updatedAt = $now
            error = $null
        }
    }
    Save-QQRiskState -Root $Root -State $state
    return $state
}

function Get-OwnedNapCatProcesses {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$BotQQ
    )

    $launcherPath = Join-Path $Root 'runtime\napcat\NapCatWinBootMain.exe'
    if (-not (Test-Path -LiteralPath $launcherPath)) { return @() }
    $pattern = '(?:^|\s)-q\s+' + [regex]::Escape($BotQQ) + '(?:\s|$)'
    return @(Get-CimInstance Win32_Process -Filter "Name='NapCatWinBootMain.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $launcherPath -and $_.CommandLine -match $pattern })
}

function Get-QQLoginDiagnostic {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$BotQQ
    )

    $result = [pscustomobject]@{ state = 'unknown'; reason = ''; source = 'napcat-log' }
    $recordPath = Join-Path $Root 'napcat-process.json'
    $logPath = Join-Path $Root 'logs\napcat.log'
    try {
        $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$record.botQQ -ne $BotQQ -or -not $record.startedAt) { return $result }
        $since = [DateTimeOffset]::Parse($record.startedAt).LocalDateTime.AddSeconds(-2)
        # The first part retains the quick-login error after QR refreshes fill
        # the tail. Inspect only this account's current launch, never old logs.
        $lines = @(Get-Content -LiteralPath $logPath -Head 160 -Encoding UTF8 -ErrorAction Stop) +
            @(Get-Content -LiteralPath $logPath -Tail 120 -Encoding UTF8 -ErrorAction Stop)
        $log = Get-Item -LiteralPath $logPath -ErrorAction Stop
        if ($log.LastWriteTime -lt $since) { return $result }
        $hasQr = $false
        foreach ($line in $lines) {
            if ($line -notmatch '^(?<date>\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s') { continue }
            $stamp = [datetime]::ParseExact(
                ([string]$since.Year + '-' + $Matches.date), 'yyyy-MM-dd HH:mm:ss',
                [System.Globalization.CultureInfo]::InvariantCulture)
            if ($stamp -lt $since) { continue }
            if ($line -match '快速登录错误.*(?:用户身份已失效|身份.*失效|请.*重新登录)') {
                $result.state = 'credentials_expired'
                $result.reason = 'QQ 拒绝快速登录：保存的登录身份已失效，需要本人重新登录一次。'
                return $result
            }
            if ($line -match '请扫描下面的二维码') { $hasQr = $true }
        }
        if ($hasQr) {
            $result.state = 'login_required'
            $result.reason = 'QQ 正在等待本人完成登录或验证。'
        }
    } catch { }
    return $result
}

function Get-DafeilongQQHealth {
    param([Parameter(Mandatory = $true)][string]$Root)

    $risk = Get-QQRiskState -Root $Root
    $cfg = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $processExists = $false
    try { $processExists = @(Get-OwnedNapCatProcesses -Root $Root -BotQQ ([string]$cfg.botQQ)).Count -gt 0 } catch {}

    $onebotListening = $false
    try {
        $onebotListening = $null -ne (Get-NetTCPConnection -LocalPort ([uri]$cfg.onebotUrl).Port -State Listen -ErrorAction SilentlyContinue)
    } catch {}

    $bridgeProcess = $false
    $bridgeReady = $false
    $qqOnline = $false
    $status = $null
    $statusPath = Join-Path $Root 'status.json'
    if (Test-Path -LiteralPath $statusPath) {
        try {
            $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $bridge = Get-CimInstance Win32_Process -Filter "ProcessId=$($status.pid)" -ErrorAction SilentlyContinue
            $bridgeProcess = $null -ne $bridge -and $bridge.Name -eq 'node.exe' -and
                $bridge.CommandLine.Contains((Join-Path $Root 'bridge.mjs'))
            $bridgeReady = $bridgeProcess -and [string]$status.botQQ -eq [string]$cfg.botQQ -and
                $status.state -in @('ready', 'answering', 'considering')
            $qqOnline = $status.qqOnline -eq $true
        } catch {}
    }

    $astrbotRunner = Join-Path $Root 'run-astrbot.py'
    $astrbotProcess = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($astrbotRunner) } |
        Select-Object -First 1

    $loginDiagnostic = [pscustomobject]@{ state = 'unknown'; reason = ''; source = '' }
    if ($bridgeReady -and $qqOnline) {
        $loginDiagnostic.state = 'online'
    } elseif ($onebotListening) {
        # A previous failed quick login must not override a now-live endpoint.
        $loginDiagnostic.state = 'checking_connection'
    } else {
        $loginDiagnostic = Get-QQLoginDiagnostic -Root $Root -BotQQ ([string]$cfg.botQQ)
    }

    [pscustomobject]@{
        configuredQQ = [string]$cfg.botQQ
        riskPaused = $risk.paused -eq $true
        riskReason = [string]$risk.reason
        riskUpdatedAt = $risk.updatedAt
        processExists = [bool]$processExists
        loginConfirmed = [bool]($bridgeReady -and $qqOnline)
        loginState = $loginDiagnostic.state
        loginReason = $loginDiagnostic.reason
        onebotListening = [bool]$onebotListening
        astrBotGateway = $null -ne $astrbotProcess
        bridgeProcess = [bool]$bridgeProcess
        bridgeReady = [bool]$bridgeReady
        realMessageDelivery = 'unknown'
        lastHeartbeatAt = $status.lastHeartbeatAt
        lastHeartbeatError = $status.lastHeartbeatError
        bridgeState = $status.state
    }
}

function Test-QQRetryStorm {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][datetime]$Since
    )

    $log = Join-Path $Root 'logs\napcat.log'
    if (-not (Test-Path -LiteralPath $log)) { return $false }
    $prompts = 0
    $year = (Get-Date).Year
    foreach ($line in (Get-Content -LiteralPath $log -Tail 240 -ErrorAction SilentlyContinue)) {
        if ($line -match '^(?<month>\d{2})-(?<day>\d{2}) (?<time>\d{2}:\d{2}:\d{2}).*请扫描下面的二维码') {
            try {
                $stamp = [datetime]::ParseExact(
                    "$year-$($Matches.month)-$($Matches.day) $($Matches.time)",
                    'yyyy-MM-dd HH:mm:ss',
                    [System.Globalization.CultureInfo]::InvariantCulture
                )
                if ($stamp -ge $Since) { $prompts++ }
            } catch {}
        }
    }
    return $prompts -ge 2
}
