param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Pause', 'Resume')]
    [string]$Action,
    [string]$Reason = 'QQ 安全中心提示：设备存在外挂或其他软件影响 QQ 正常使用。'
)

$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
. (Join-Path $taskRoot 'QQ-Risk-Control.ps1')
$cfg = Get-Content -LiteralPath (Join-Path $taskRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json

if ($Action -eq 'Resume') {
    $state = Set-QQRiskState -Root $taskRoot -Action Resume -Source 'control-panel'
    Write-Output 'QQ 风控暂停已解除。关闭官方 QQ 客户端后，再由本人点击启动并在官方登录页完成一次验证。'
    $state | ConvertTo-Json -Depth 8
    exit 0
}

$state = Set-QQRiskState -Root $taskRoot -Action Pause -Reason $Reason -Source 'control-panel'

$tasksPath = Join-Path $taskRoot 'data\service-tasks.json'
if (Test-Path -LiteralPath $tasksPath) {
    $tasks = Get-Content -LiteralPath $tasksPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @($tasks.qq, $tasks.core)) {
        if ($name) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
    }
}

& (Join-Path $taskRoot 'Stop.ps1') | Out-Null
if (Test-Path -LiteralPath (Join-Path $taskRoot 'Stop-AstrBot.ps1')) {
    & (Join-Path $taskRoot 'Stop-AstrBot.ps1') | Out-Null
}
foreach ($process in @(Get-OwnedNapCatProcesses -Root $taskRoot -BotQQ ([string]$cfg.botQQ))) {
    & taskkill.exe /PID $process.ProcessId /T /F | Out-Null
}

Write-Output 'QQ 风控安全暂停已启用；不会自动重登或启动机器人消息链路。'
$state | ConvertTo-Json -Depth 8
