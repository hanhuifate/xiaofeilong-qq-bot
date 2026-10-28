param([Parameter(Mandatory=$true)][ValidatePattern('^[1-9]\d{4,11}$')][string]$BotQQ,
      [Parameter(Mandatory=$true)][ValidatePattern('^[1-9]\d{4,11}$')][string]$ExpectedQQ)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
. (Join-Path $taskRoot 'QQ-Risk-Control.ps1')
$risk = Get-QQRiskState -Root $taskRoot
if ($risk.paused) { throw ('QQ 风控安全暂停期间禁止切换或启动账号。请先在官方安全中心完成验证，再解除暂停。' + $risk.reason) }
$mutex = New-Object System.Threading.Mutex($false, 'Local\DafeilongQQAccountSwitch')
$locked = $false
$servicesStopped = $false
$statusFile = Join-Path $taskRoot 'data\account-change-status.json'
function Save-ChangeStatus([string]$state,[string]$message) {
    $temp = $statusFile + '.tmp'
    @{ state=$state; message=$message; botQQ=$BotQQ; oldQQ=$ExpectedQQ; at=(Get-Date).ToString('o'); pid=$PID } |
      ConvertTo-Json | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $statusFile -Force
}
try {
    try { $locked=$mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked=$true }
    if (-not $locked) { throw '另一个账号切换正在进行，请稍后刷新。' }
    $engine = Join-Path $taskRoot 'accounts.mjs'
    $inspection = & node.exe $engine inspect $BotQQ $ExpectedQQ
    if ($LASTEXITCODE -ne 0) { throw '账号或配置校验失败，未停止当前服务。' }
    $plan = $inspection | ConvertFrom-Json
    if (-not $plan.changed) { Save-ChangeStatus 'unchanged' '号码未改变；可直接打开QQ登录页。'; exit 0 }
    Save-ChangeStatus 'switching' '正在停止原账号接入并保存新号码…'
    $tasksPath = Join-Path $taskRoot 'data\service-tasks.json'
    if (Test-Path -LiteralPath $tasksPath) {
        $tasks = Get-Content -LiteralPath $tasksPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($tasks.qq) { Stop-ScheduledTask -TaskName $tasks.qq -ErrorAction Stop }
    }
    $servicesStopped = $true
    & (Join-Path $taskRoot 'Stop.ps1')
    & (Join-Path $taskRoot 'Stop-AstrBot.ps1')
    $launcherPath = Join-Path $taskRoot 'runtime\napcat\NapCatWinBootMain.exe'
    $pattern = '(?:^|\s)-q\s+' + [regex]::Escape($ExpectedQQ) + '(?:\s|$)'
    $owned = @(Get-CimInstance Win32_Process -Filter "Name='NapCatWinBootMain.exe'" | Where-Object {
        $_.ExecutablePath -eq $launcherPath -and $_.CommandLine -match $pattern
    })
    foreach ($launcher in $owned) {
        & taskkill.exe /PID $launcher.ProcessId /T /F | Out-Null
        if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $launcher.ProcessId -ErrorAction SilentlyContinue)) { throw '原机器人接入进程未能停止，未修改账号。' }
    }
    $result = & node.exe $engine apply $BotQQ $ExpectedQQ
    if ($LASTEXITCODE -ne 0) { throw '保存账号失败，请查看账号切换日志；备份和原登录数据保留。' }
    # Ignore the old account's startup cooldown, without removing its login data.
    @{ botQQ=$ExpectedQQ; startedAt=(Get-Date).ToString('o'); launcherPid=0 } | ConvertTo-Json |
      Set-Content -LiteralPath (Join-Path $taskRoot 'napcat-process.json') -Encoding UTF8
    Save-ChangeStatus 'configured' '机器人号码已保存，正在启动新账号；如未自动登录，请打开QQ登录页完成验证。'
} catch {
    if ($locked) { Save-ChangeStatus 'failed' $_.Exception.Message }
    Write-Error $_.Exception.Message
} finally {
    if ($servicesStopped) {
        try { & (Join-Path $taskRoot 'Start.ps1') } catch { if($locked){Save-ChangeStatus 'failed' ('号码配置已保留，启动失败：'+$_.Exception.Message)} }
    }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
