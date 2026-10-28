Add-Type -AssemblyName PresentationFramework

$ErrorActionPreference = 'Stop'
$botRoot = $PSScriptRoot
$configPath = Join-Path $botRoot 'config.json'
. (Join-Path $botRoot 'QQ-Risk-Control.ps1')

$panelHash = [Security.Cryptography.SHA256]::Create()
try { $panelDigest=$panelHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($botRoot.ToLowerInvariant())); $panelKey=([BitConverter]::ToString($panelDigest)).Replace('-','').Substring(0,16) } finally { $panelHash.Dispose() }
$panelCreated = $false
$panelMutex = New-Object Threading.Mutex($true, ('Local\DafeilongPanel-'+$panelKey), [ref]$panelCreated)
if (-not $panelCreated) {
    try { $existingPanel = [Threading.EventWaitHandle]::OpenExisting('Local\DafeilongPanelShow-'+$panelKey); $existingPanel.Set() | Out-Null; $existingPanel.Dispose() } catch {}
    $panelMutex.Dispose()
    exit 0
}
$panelShow = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::AutoReset, ('Local\DafeilongPanelShow-'+$panelKey))

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="大肥龙 · QQ 机器人控制面板" Width="820" Height="450"
        WindowStartupLocation="CenterScreen" ResizeMode="CanMinimize" Background="#F6F7FB">
  <Grid Margin="22">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto" />
      <RowDefinition Height="18" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="18" />
      <RowDefinition Height="Auto" />
      <RowDefinition Height="*" />
    </Grid.RowDefinitions>
    <Border Grid.Row="0" Padding="18" Background="White" CornerRadius="10" BorderBrush="#E2E5EE" BorderThickness="1">
      <Grid>
        <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <StackPanel>
          <TextBlock Text="大肥龙" FontSize="25" FontWeight="SemiBold" Foreground="#172033" />
          <TextBlock x:Name="StatusText" Margin="0,7,0,0" FontSize="14" Foreground="#536076" Text="正在读取状态…" />
          <TextBlock x:Name="DetailText" Margin="0,4,0,0" FontSize="12" Foreground="#7A8498" TextWrapping="Wrap" />
        </StackPanel>
        <Button x:Name="RefreshButton" Grid.Column="1" Content="刷新状态" Padding="14,7" Margin="12,0,0,0" VerticalAlignment="Top" />
      </Grid>
    </Border>
    <Grid Grid.Row="2">
      <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition/><ColumnDefinition/><ColumnDefinition/></Grid.ColumnDefinitions>
      <Button x:Name="StartAllButton" Grid.Column="0" Content="启动机器人" Height="42" Margin="0,0,8,0" FontWeight="SemiBold" />
      <Button x:Name="RestartButton" Grid.Column="1" Content="重启回复服务" Height="42" Margin="4,0" />
      <Button x:Name="StopButton" Grid.Column="2" Content="停止回复" Height="42" Margin="8,0,0,0" />
      <Button x:Name="RiskButton" Grid.Column="3" Content="启用风控暂停" Height="42" Margin="8,0,0,0" />
    </Grid>
    <Grid Grid.Row="4">
      <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition/><ColumnDefinition/><ColumnDefinition/><ColumnDefinition/><ColumnDefinition/></Grid.ColumnDefinitions>
      <Button x:Name="ViewerButton" Grid.Column="0" Content="打开控制中心" Height="36" Margin="0,0,6,0" />
      <Button x:Name="LoginButton" Grid.Column="1" Content="打开 QQ 登录页" Height="36" Margin="2,0,4,0" />
      <Button x:Name="DoubaoButton" Grid.Column="2" Content="群管理 / 生图" Height="36" Margin="4,0,2,0" />
      <Button x:Name="AccountButton" Grid.Column="3" Content="机器人 QQ 号" Height="36" Margin="6,0,0,0" />
      <Button x:Name="FolderButton" Grid.Column="4" Content="打开文件夹" Height="36" Margin="6,0,0,0" />
      <Button x:Name="RestoreButton" Grid.Column="5" Content="恢复备份" Height="36" Margin="6,0,0,0" />
    </Grid>
    <TextBlock Grid.Row="5" Margin="2,18,2,0" TextWrapping="Wrap" FontSize="12" Foreground="#667085"
      Text="风控暂停会停止机器人 QQ、OneBot、AstrBot 与回复链路，且不会关闭你正在使用的普通 QQ。恢复前请先在官方 QQ 安全中心完成验证；解除暂停只开放一次人工登录，连续生成二维码会自动再次暂停。" />
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$statusText = $window.FindName('StatusText')
$detailText = $window.FindName('DetailText')

function Get-BotState {
    $health = Get-DafeilongQQHealth -Root $botRoot
    $viewer = $false
    $replyError = ''
    $doubaoBrowser = $false
    $doubaoAuto = $true
    $imageProvider = 'chatgpt'
    $imageSettingsPath = Join-Path $botRoot 'data\image-generation-settings.json'
    if (Test-Path -LiteralPath $imageSettingsPath) { try { $imageProvider = (Get-Content -LiteralPath $imageSettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json).provider } catch {} }
    $statusPath = Join-Path $botRoot 'status.json'
    if (Test-Path -LiteralPath $statusPath) {
        try {
            $saved = Get-Content -LiteralPath $statusPath -Encoding UTF8 -Raw | ConvertFrom-Json
            $replyError = if ($saved.lastError -eq 'MODEL_USAGE_LIMIT') { '账户模型额度暂不可用' } else { $saved.lastError }
            if ($saved.viewerPort) {
                $viewer = $null -ne (Get-NetTCPConnection -LocalPort $saved.viewerPort -State Listen -ErrorAction SilentlyContinue)
            }
        } catch { $replyError = '状态文件无法读取' }
    }
    $doubaoState = Join-Path $botRoot 'data\doubao-browser.json'
    if (Test-Path -LiteralPath $doubaoState) {
        try { $doubaoAuto = (Get-Content -LiteralPath $doubaoState -Raw -Encoding UTF8 | ConvertFrom-Json).enabled -ne $false } catch { }
    }
    $profile = Join-Path $botRoot 'runtime\autodoubao\chrome-profile'
    $doubaoBrowser = $null -ne (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq 'chrome.exe' -and $_.CommandLine -like "*$profile*" -and $_.CommandLine -notmatch '\s--type='
    } | Select-Object -First 1)
    [pscustomobject]@{
        RiskPaused = $health.riskPaused
        RiskReason = $health.riskReason
        Bridge = $health.bridgeProcess
        Adapter = $health.onebotListening
        AdapterProcess = $health.processExists
        LoginConfirmed = $health.loginConfirmed
        LoginState = $health.loginState
        LoginReason = $health.loginReason
        AstrBotGateway = $health.astrBotGateway
        ReplyReady = $health.bridgeReady
        ReplyError = $replyError
        Viewer = $viewer
        DoubaoBrowser = $doubaoBrowser
        DoubaoAuto = $doubaoAuto
        ImageProvider = $imageProvider
        Detail = $health.lastHeartbeatError
    }
}

function Update-Status {
    $state = Get-BotState
    $window.FindName('RiskButton').Content = if ($state.RiskPaused) { '解除风控暂停' } else { '启用风控暂停' }
    $window.FindName('StartAllButton').IsEnabled = -not $state.RiskPaused
    $window.FindName('RestartButton').IsEnabled = -not $state.RiskPaused
    $window.FindName('LoginButton').IsEnabled = -not $state.RiskPaused
    if ($state.RiskPaused) {
        $statusText.Text = '● QQ 风控安全暂停'
        $statusText.Foreground = [System.Windows.Media.Brushes]::Firebrick
    } elseif ($state.LoginState -eq 'credentials_expired') {
        $statusText.Text = '● QQ 登录身份已失效，需要本人重新登录'
        $statusText.Foreground = [System.Windows.Media.Brushes]::DarkOrange
    } elseif ($state.Bridge -and $state.LoginConfirmed -and $state.AstrBotGateway -and -not $state.ReplyError) {
        $statusText.Text = '● 机器人正在运行'
        $statusText.Foreground = [System.Windows.Media.Brushes]::ForestGreen
    } elseif ($state.Bridge -and $state.ReplyError) {
        $statusText.Text = '● 回复服务异常：' + $state.ReplyError
        $statusText.Foreground = [System.Windows.Media.Brushes]::Firebrick
    } elseif ($state.Bridge -and $state.Adapter) {
        $statusText.Text = '● QQ 接口已启动，回复服务正在重连'
        $statusText.Foreground = [System.Windows.Media.Brushes]::DarkOrange
    } elseif ($state.AdapterProcess) {
        $statusText.Text = '● QQ 进程已启动，账号尚未完成登录或验证'
        $statusText.Foreground = [System.Windows.Media.Brushes]::DarkOrange
    } elseif ($state.Bridge) {
        $statusText.Text = '● 回复服务已启动，QQ 适配器未连接'
        $statusText.Foreground = [System.Windows.Media.Brushes]::DarkOrange
    } elseif ($state.Adapter) {
        $statusText.Text = '● QQ 已连接，回复服务未启动'
        $statusText.Foreground = [System.Windows.Media.Brushes]::DarkOrange
    } else {
        $statusText.Text = '● 机器人未运行'
        $statusText.Foreground = [System.Windows.Media.Brushes]::Firebrick
    }
    $parts = @()
    if ($state.RiskPaused) { $parts += ('原因：' + $state.RiskReason) }
    if ($state.LoginReason) { $parts += $state.LoginReason }
    if ($state.Detail) { $parts += ('异常：' + $state.Detail) }
    $parts += if ($state.AdapterProcess) { 'QQ 进程：运行' } else { 'QQ 进程：停止' }
    $parts += if ($state.LoginConfirmed) { 'QQ 登录：已确认' } else { 'QQ 登录：未确认' }
    $parts += if ($state.Adapter) { 'OneBot：监听中' } else { 'OneBot：未监听' }
    $parts += if ($state.AstrBotGateway) { 'AstrBot：运行' } else { 'AstrBot：停止' }
    $parts += if ($state.Bridge) { '回复服务：运行' } else { '回复服务：停止' }
    $parts += if ($state.Viewer) { '对话后台可打开' } else { '对话后台未启动' }
    $parts += if ($state.ImageProvider -eq 'chatgpt') { '生图来源：ChatGPT；网页登录与任务状态见控制中心' } elseif ($state.DoubaoBrowser) { '豆包生图浏览器运行中' } elseif ($state.DoubaoAuto) { '豆包生图浏览器正在恢复' } else { '豆包生图浏览器已停止' }
    $parts += '真实消息交付：未本轮验证'
    $detailText.Text = $parts -join ' · '
}

function Invoke-BotScript([string]$name, [string[]]$arguments = @(), [switch]$Wait) {
    $scriptPath = Join-Path $botRoot $name
    if (-not (Test-Path -LiteralPath $scriptPath)) { throw "Script not found: $name" }
    $launchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', ('"' + $scriptPath + '"')) + $arguments
    $logDir = Join-Path $botRoot 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $logName = ([IO.Path]::GetFileNameWithoutExtension($name)) + '-' + [guid]::NewGuid().ToString('N')
    $child = Start-Process -FilePath 'powershell.exe' -ArgumentList $launchArgs -WorkingDirectory $botRoot -WindowStyle Hidden -PassThru -Wait:$Wait -RedirectStandardOutput (Join-Path $logDir ($logName + '.log')) -RedirectStandardError (Join-Path $logDir ($logName + '.error.log'))
    if ($Wait -and $child.ExitCode -ne 0) { throw "Script failed: $name (exit $($child.ExitCode)). See logs/$logName.error.log" }
}

$window.FindName('RefreshButton').Add_Click({ Update-Status })
$window.FindName('StartAllButton').Add_Click({
    Invoke-BotScript 'Start.ps1'
    $statusText.Text = '正在启动…'
    $statusText.Foreground = [System.Windows.Media.Brushes]::DarkOrange
})
$window.FindName('RestartButton').Add_Click({
    Invoke-BotScript 'Stop.ps1' -Wait
    Invoke-BotScript 'Start.ps1' @('-BridgeOnly')
    $statusText.Text = '正在重启回复服务…'
    $statusText.Foreground = [System.Windows.Media.Brushes]::DarkOrange
})
$window.FindName('StopButton').Add_Click({
    Invoke-BotScript 'Stop.ps1'
    $statusText.Text = '正在停止回复服务…'
    $statusText.Foreground = [System.Windows.Media.Brushes]::DarkOrange
})
$window.FindName('RiskButton').Add_Click({
    $state = Get-BotState
    if ($state.RiskPaused) {
        $message = "只在已经通过官方 QQ 安全中心完成验证，并确认不会与普通 QQ 桌面端冲突时解除暂停。`n`n解除后不会自动启动，仍需你点击「启动机器人」并本人完成一次登录或验证。是否解除风控暂停？"
        $answer = [System.Windows.MessageBox]::Show($message, '解除 QQ 风控暂停', 'YesNo', 'Warning')
        if ($answer -ne 'Yes') { return }
        Invoke-BotScript 'Set-QQ-Risk-Control.ps1' @('-Action', 'Resume') -Wait
        $statusText.Text = '● 风控暂停已解除；请本人确认后启动'
        $statusText.Foreground = [System.Windows.Media.Brushes]::DarkOrange
    } else {
        Invoke-BotScript 'Set-QQ-Risk-Control.ps1' @('-Action', 'Pause') -Wait
        $statusText.Text = '● QQ 风控安全暂停'
        $statusText.Foreground = [System.Windows.Media.Brushes]::Firebrick
    }
    Update-Status
})
$window.FindName('ViewerButton').Add_Click({
    if ((Get-BotState).Bridge) { Invoke-BotScript 'View-Sessions.ps1' }
    else { [System.Windows.MessageBox]::Show('请先启动机器人。', '大肥龙') | Out-Null }
})
$window.FindName('LoginButton').Add_Click({
    if ((Get-BotState).RiskPaused) {
        [System.Windows.MessageBox]::Show('风控暂停期间不打开 QQ 登录页。请先在官方 QQ 安全中心完成验证，再解除暂停。', '大肥龙') | Out-Null
    } else {
        Invoke-BotScript 'Open-QQ-Login.ps1'
    }
})
$window.FindName('DoubaoButton').Add_Click({
    Invoke-BotScript 'Local-Features-Panel.ps1'
})
$window.FindName('FolderButton').Add_Click({ Start-Process explorer.exe -ArgumentList $botRoot })
$window.FindName('AccountButton').Add_Click({ Invoke-BotScript 'QQ-Account-Panel.ps1' })
$window.FindName('RestoreButton').Add_Click({ Invoke-BotScript 'Restore-Backup.ps1' })

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(3)
$timer.Add_Tick({ if($panelShow.WaitOne(0)){ $window.WindowState='Normal'; $window.Activate() | Out-Null }; Update-Status })
$window.Add_Closed({ $timer.Stop(); $panelShow.Dispose(); $panelMutex.ReleaseMutex(); $panelMutex.Dispose() })
$window.Dispatcher.Add_UnhandledException({
    param($sender, $eventArgs)
    $eventArgs.Handled = $true
    $statusText.Text = '操作失败：' + $eventArgs.Exception.GetBaseException().Message
    $statusText.Foreground = [System.Windows.Media.Brushes]::Firebrick
})
Update-Status
$timer.Start()
if ($env:QQ_PANEL_SMOKE_TEST -eq '1') {
    Invoke-BotScript 'Manage-Doubao-Browser.ps1' @('-Action', 'Status') -Wait
    $smokeTimer = New-Object Windows.Threading.DispatcherTimer
    $smokeTimer.Interval = [TimeSpan]::FromMilliseconds(500)
    $smokeTimer.Add_Tick({
        $smokeTimer.Stop()
        $window.FindName('RefreshButton').RaiseEvent((New-Object Windows.RoutedEventArgs ([Windows.Controls.Button]::ClickEvent)))
        $window.Close()
    })
    $smokeTimer.Start()
}
[void]$window.ShowDialog()
if ($env:QQ_PANEL_SMOKE_TEST -eq '1') { Write-Output 'PANEL_SMOKE_OK' }
