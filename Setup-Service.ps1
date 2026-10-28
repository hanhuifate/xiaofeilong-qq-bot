$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$scriptPath = Join-Path $taskRoot 'Supervise.ps1'
$names = @{ core='DafeilongCore'; qq='DafeilongQQ'; doubao='DafeilongDoubao' }
foreach ($name in $names.Values) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing -and -not (($existing.Actions | Select-Object -First 1).Arguments.Contains($scriptPath))) { throw "Task $name belongs to another directory; it was not changed." }
}
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
foreach ($component in $names.Keys) {
    $arguments = '//nologo "' + (Join-Path $taskRoot 'Run-Hidden.vbs') + '" "' + $scriptPath + '" -Component ' + $component
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument $arguments -WorkingDirectory $taskRoot
    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description ('Dafeilong local component: ' + $component)
    Register-ScheduledTask -TaskName $names[$component] -InputObject $task -Force | Out-Null
}
$names | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot 'data\service-tasks.json') -Encoding UTF8
Write-Output 'Independent local supervisors installed. Automatic logon startup is not enabled.'
