Add-Type -AssemblyName PresentationFramework
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$settingsFile = Join-Path $root 'data\moderation-settings.json'
$settings = @{ enabled = $true; dryRun = $false; owners = @(); approvalSeconds = 120 }
if (Test-Path -LiteralPath $settingsFile) {
    $saved = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $settings.enabled = $saved.enabled
    $settings.dryRun = $saved.dryRun
    $settings.owners = @($saved.owners)
}
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
 Title="大肥龙 · 本机群管理与生图" Width="720" Height="690" WindowStartupLocation="CenterScreen">
 <StackPanel Margin="20">
  <TextBlock Text="群管理" FontSize="20" Margin="0,0,0,10"/>
  <CheckBox x:Name="Enabled" Content="开启群管理（仍需管理员提出并确认原操作）" Margin="0,0,0,8"/>
  <CheckBox x:Name="DryRun" Content="演练模式：校验权限与确认，但不实际禁言、撤回或处理申请" Margin="0,0,0,10"/>
  <TextBlock Text="主人 QQ 号（接收申请建议、处理好友申请；多个用逗号分隔。留空不授予主人权限）" TextWrapping="Wrap"/>
  <TextBox x:Name="Owners" Height="28" Margin="0,6,0,10"/>
  <Button x:Name="Save" Content="保存群管理设置（即时生效）" Height="32"/>
  <TextBlock Text="群内管理每次检查真实角色；确认绑定发起人、群号、原操作，120 秒过期。" TextWrapping="Wrap" Margin="0,8,0,15"/>
  <TextBlock Text="图片生成（默认 ChatGPT）" FontSize="20" Margin="0,0,0,10"/>
  <Button x:Name="ImageSettings" Content="打开控制中心：选择来源、登录、等待与图片分组" Height="32" Margin="0,0,0,10"/>
  <TextBlock Text="以下为备用豆包服务" Margin="0,0,0,8"/>
  <WrapPanel>
   <Button x:Name="StartBrowser" Content="开启后台守护" Padding="10,6" Margin="0,0,8,0"/>
   <Button x:Name="StopBrowser" Content="关闭后台守护" Padding="10,6" Margin="0,0,8,0"/>
   <Button x:Name="RestartBrowser" Content="重启专用浏览器" Padding="10,6" Margin="0,0,8,0"/>
   <Button x:Name="Login" Content="打开登录设置" Padding="10,6"/>
  </WrapPanel>
  <Button x:Name="Status" Content="刷新豆包连接与近期任务" Height="32" Margin="0,10,0,10"/>
  <TextBox x:Name="Output" Height="170" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto"/>
 </StackPanel>
</Window>
'@
$window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$window.FindName('Enabled').IsChecked = [bool]$settings.enabled
$window.FindName('DryRun').IsChecked = [bool]$settings.dryRun
$window.FindName('Owners').Text = $settings.owners -join ','
$outputBox = $window.FindName('Output')
function Launch-BrowserAction([string]$action) {
    $launchArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + (Join-Path $root 'Manage-Doubao-Browser.ps1') + '"'),'-Action',$action)
    Start-Process powershell.exe -ArgumentList $launchArgs -WindowStyle Hidden
    $outputBox.Text = '操作已提交，稍后点击刷新查看真实连接。'
}
$window.FindName('Save').Add_Click({
    $owners = @($window.FindName('Owners').Text -split '[,，;；\s]+' | Where-Object { $_ })
    if ($owners | Where-Object { $_ -notmatch '^\d{5,12}$' }) { $outputBox.Text = 'QQ 号格式不正确，请只填写号码。'; return }
    New-Item -ItemType Directory -Force -Path (Split-Path $settingsFile) | Out-Null
    @{ enabled = [bool]$window.FindName('Enabled').IsChecked; dryRun = [bool]$window.FindName('DryRun').IsChecked; owners = @($owners | Select-Object -Unique); approvalSeconds = 120 } |
      ConvertTo-Json | Set-Content -LiteralPath $settingsFile -Encoding UTF8
    $outputBox.Text = '群管理设置已保存，下一次请求即时使用新设置。'
})
$window.FindName('StartBrowser').Add_Click({ Launch-BrowserAction 'Start' })
$window.FindName('ImageSettings').Add_Click({
    Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + (Join-Path $root 'View-Sessions.ps1') + '"')) -WindowStyle Hidden
})
$window.FindName('StopBrowser').Add_Click({ Launch-BrowserAction 'Stop' })
$window.FindName('RestartBrowser').Add_Click({ Launch-BrowserAction 'Restart' })
$window.FindName('Login').Add_Click({
    Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',('"' + (Join-Path $root 'Open-Doubao-Image-Setup.ps1') + '"')) -WindowStyle Normal
})
$window.FindName('Status').Add_Click({
    $outputBox.Text = '正在检查实际连接…'
    try { $outputBox.Text = (& node.exe (Join-Path $root 'doubao-status.mjs') 2>&1 | Out-String) }
    catch { $outputBox.Text = '检查失败：' + $_.Exception.Message }
})
$window.Dispatcher.Add_UnhandledException({ param($sender,$eventArgs); $eventArgs.Handled = $true; $outputBox.Text = $eventArgs.Exception.GetBaseException().Message })
if ($env:QQ_PANEL_SMOKE_TEST -eq '1') {
    $timer = New-Object Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(300)
    $timer.Add_Tick({ $timer.Stop(); $window.Close() })
    $timer.Start()
}
[void]$window.ShowDialog()
if ($env:QQ_PANEL_SMOKE_TEST -eq '1') { Write-Output 'FEATURE_PANEL_OK' }
