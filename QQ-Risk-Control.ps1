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

    [pscustomobject]@{
        configuredQQ = [string]$cfg.botQQ
        riskPaused = $risk.paused -eq $true
        riskReason = [string]$risk.reason
        riskUpdatedAt = $risk.updatedAt
        processExists = [bool]$processExists
        loginConfirmed = [bool]($bridgeReady -and $qqOnline)
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
