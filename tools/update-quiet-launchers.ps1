$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$launcher=Join-Path $taskRoot 'Run-Hidden.vbs'
if(-not (Test-Path -LiteralPath $launcher)){throw 'Hidden launcher is missing.'}
$backup=Join-Path $taskRoot ('data\change-backups\quiet-links-'+(Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$shell=New-Object -ComObject WScript.Shell
$links=@((Join-Path ([Environment]::GetFolderPath('Desktop')) '大肥龙控制面板.cmd - 快捷方式.lnk'),(Join-Path $taskRoot '大肥龙控制面板.cmd - 快捷方式.lnk'))
foreach($file in $links){
  if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination (Join-Path $backup (([IO.Path]::GetFileName((Split-Path $file)))+'.lnk'))}
  $link=$shell.CreateShortcut($file)
  $link.TargetPath=Join-Path $env:SystemRoot 'System32\wscript.exe'
  $link.Arguments='//nologo "'+$launcher+'" Control-Panel.ps1'
  $link.WorkingDirectory=$taskRoot
  $link.WindowStyle=7
  $link.Description='小肥龙控制面板：无命令窗口启动'
  $link.Save()
}
$tasksFile=Join-Path $taskRoot 'data\service-tasks.json'
if(Test-Path -LiteralPath $tasksFile){
  $names=Get-Content -LiteralPath $tasksFile -Raw -Encoding UTF8|ConvertFrom-Json
  $supervisor=Join-Path $taskRoot 'Supervise.ps1'
  foreach($component in @('core','qq','doubao')){
    $name=$names.$component;if(-not $name){continue}
    $task=Get-ScheduledTask -TaskName $name -ErrorAction Stop
    if(-not (($task.Actions|Select-Object -First 1).Arguments.Contains($supervisor))){throw 'A scheduled task belongs to a different directory.'}
    Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $backup ($name+'.xml')) -Encoding UTF8
    $action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument ('//nologo "'+$launcher+'" "'+$supervisor+'" -Component '+$component) -WorkingDirectory $taskRoot
    Set-ScheduledTask -TaskName $name -Action $action | Out-Null
  }
}
Write-Output 'Shortcuts and service entry points updated; existing login sessions and startup triggers preserved.'
