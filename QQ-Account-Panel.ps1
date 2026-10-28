Add-Type -AssemblyName PresentationFramework
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
. (Join-Path $taskRoot 'QQ-Risk-Control.ps1')
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
 Title="大肥龙 · 机器人QQ号管理" Width="660" Height="510" WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize" Background="#F6F7FB">
 <StackPanel Margin="22">
  <TextBlock Text="机器人 QQ 号管理" FontSize="23" FontWeight="SemiBold" Margin="0,0,0,12"/>
  <TextBlock x:Name="Current" FontSize="15" Margin="0,0,0,6"/>
  <TextBlock x:Name="Connection" Foreground="#536076" TextWrapping="Wrap" Margin="0,0,0,8"/>
  <TextBlock x:Name="Risk" Foreground="#B54708" TextWrapping="Wrap" Margin="0,0,0,16"/>
  <TextBlock Text="选择已配置号码，或填写新的机器人QQ号（无需密码）" TextWrapping="Wrap"/>
  <ComboBox x:Name="Account" IsEditable="True" Height="32" FontSize="16" Margin="0,7,0,13"/>
  <TextBlock Text="切换时会停止旧账号的机器人接入，随后启动新账号；同一时间只接入一个机器人QQ号。大肥龙的人设、主人设置、聊天记忆和图库继续沿用。原账号登录数据及配置保留，可再切回。新账号首次使用仍需本人登录或验证。" TextWrapping="Wrap" Foreground="#667085" Margin="0,0,0,16"/>
  <WrapPanel>
   <Button x:Name="Save" Content="保存并切换（重启QQ接入）" Padding="12,8" Margin="0,0,10,0"/>
   <Button x:Name="Login" Content="打开QQ登录页" Padding="12,8" Margin="0,0,10,0"/>
   <Button x:Name="Refresh" Content="刷新状态" Padding="12,8" Margin="0,0,10,0"/>
   <Button x:Name="RiskButton" Content="启用风控暂停" Padding="12,8"/>
  </WrapPanel>
  <TextBlock x:Name="Result" TextWrapping="Wrap" Margin="0,14,0,0" Foreground="#425066"/>
 </StackPanel>
</Window>
'@
$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$account = $window.FindName('Account')
$resultText = $window.FindName('Result')
function Refresh-Account {
    $cfg = Get-Content -LiteralPath (Join-Path $taskRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $risk = Get-QQRiskState -Root $taskRoot
    $window.FindName('Current').Text = '当前配置的机器人QQ：' + $cfg.botQQ
    $health = Get-DafeilongQQHealth -Root $taskRoot
    $online = $false
    try {
        $state = Get-Content -LiteralPath (Join-Path $taskRoot 'status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $online = $state.botQQ -eq $cfg.botQQ -and $state.state -in @('ready','answering','considering')
        if ($online) {
            $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)" -ErrorAction SilentlyContinue
            $online=$process -and $process.Name -eq 'node.exe' -and $process.CommandLine.Contains((Join-Path $taskRoot 'bridge.mjs'))
        }
    } catch { }
    $window.FindName('Connection').Text = if($risk.paused){
        'QQ 风控安全暂停：机器人 QQ、OneBot、AstrBot 和回复服务均已停用。'
    } elseif ($health.loginState -eq 'credentials_expired') {
        $health.loginReason
    } elseif($online){
        'QQ 登录与回复链路已连接。'
    } else {
        'QQ 登录尚未确认；保存号码不等于已经登录。'
    }
    $window.FindName('Risk').Text = if($risk.paused){'暂停原因：' + $risk.reason}else{'风控暂停未启用。'}
    $window.FindName('RiskButton').Content = if($risk.paused){'解除风控暂停'}else{'启用风控暂停'}
    $known = @($cfg.botQQ) + @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'runtime\napcat\config') -Filter 'napcat_*.json' -File | ForEach-Object {
        if ($_.BaseName -match '^napcat_(\d+)$') { $Matches[1] }
    })
    foreach ($number in ($known | Select-Object -Unique)) { if(-not $account.Items.Contains([string]$number)){[void]$account.Items.Add([string]$number)} }
    $busy = $false
    try {
        $change = Get-Content -LiteralPath (Join-Path $taskRoot 'data\account-change-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $busy = $change.state -eq 'switching' -and $null -ne (Get-Process -Id $change.pid -ErrorAction SilentlyContinue)
        $resultText.Text = $change.message
    } catch { }
    $window.FindName('Save').IsEnabled = -not $busy -and -not $risk.paused
    $window.FindName('Login').IsEnabled = -not $risk.paused
    return $cfg
}
$initial=Refresh-Account
$account.Text=[string]$initial.botQQ
$window.FindName('Save').Add_Click({
    $target=$account.Text.Trim()
    if($target -notmatch '^[1-9]\d{4,11}$'){$resultText.Text='QQ号请填写5到12位数字，不能以0开头。';return}
    $cfg=Get-Content -LiteralPath (Join-Path $taskRoot 'config.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if($target -eq $cfg.botQQ){$resultText.Text='号码未改变；需要登录时点击“打开QQ登录页”。';return}
    $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $taskRoot 'Switch-QQ-Account.ps1')+'"'),'-BotQQ',$target,'-ExpectedQQ',[string]$cfg.botQQ)
    $jobLog=Join-Path $taskRoot ('logs\account-switch-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
    Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -WorkingDirectory $taskRoot -RedirectStandardOutput ($jobLog+'.log') -RedirectStandardError ($jobLog+'.error.log') | Out-Null
    $window.FindName('Save').IsEnabled=$false
    $resultText.Text='正在切换，请等待状态更新；登录和验证仅在QQ登录页完成。'
})
$window.FindName('Login').Add_Click({
    if((Get-QQRiskState -Root $taskRoot).paused){
        $resultText.Text='风控暂停期间不打开登录页。请先在官方 QQ 安全中心完成验证。'
    } else {
        & (Join-Path $taskRoot 'Open-QQ-Login.ps1')
    }
})
$window.FindName('Refresh').Add_Click({[void](Refresh-Account)})
$window.FindName('RiskButton').Add_Click({
    $risk=Get-QQRiskState -Root $taskRoot
    if($risk.paused){
        $answer=[System.Windows.MessageBox]::Show("只在已经通过官方 QQ 安全中心完成验证，并确认不会与普通 QQ 桌面端冲突时解除暂停。`n`n解除后不会自动登录。是否解除？",'解除 QQ 风控暂停','YesNo','Warning')
        if($answer -ne 'Yes'){return}
        & (Join-Path $taskRoot 'Set-QQ-Risk-Control.ps1') -Action Resume | Out-Null
        $resultText.Text='风控暂停已解除；请本人确认后回到主面板启动机器人。'
    } else {
        & (Join-Path $taskRoot 'Set-QQ-Risk-Control.ps1') -Action Pause | Out-Null
        $resultText.Text='QQ 风控安全暂停已启用，自动重登与回复链路已停止。'
    }
    [void](Refresh-Account)
})
$window.Dispatcher.Add_UnhandledException({param($sender,$e);$e.Handled=$true;$resultText.Text=$e.Exception.GetBaseException().Message})
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromSeconds(3)
$timer.Add_Tick({[void](Refresh-Account)})
$window.Add_Closed({$timer.Stop()})
$timer.Start()
if($env:QQ_PANEL_SMOKE_TEST -eq '1'){
    $smokeTimer=New-Object Windows.Threading.DispatcherTimer
    $smokeTimer.Interval=[TimeSpan]::FromMilliseconds(700)
    $smokeTimer.Add_Tick({$smokeTimer.Stop();$window.Close()})
    $smokeTimer.Start()
}
[void]$window.ShowDialog()
if($env:QQ_PANEL_SMOKE_TEST -eq '1'){Write-Output 'ACCOUNT_PANEL_SMOKE_OK'}
