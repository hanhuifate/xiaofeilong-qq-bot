param([ValidateSet('Status','EnableAutostart','DisableAutostart')][string]$Action='Status')
$ErrorActionPreference = 'Stop'
$file = Join-Path $PSScriptRoot 'data\service-tasks.json'
if (-not (Test-Path -LiteralPath $file)) { @{ installed=$false; components=@() } | ConvertTo-Json -Compress; exit 0 }
$names = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
$result = @()
foreach ($name in @($names.qq,$names.doubao,$names.core)) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
    if (-not (($task.Actions | Select-Object -First 1).Arguments.Contains((Join-Path $PSScriptRoot 'Supervise.ps1')))) { throw 'Task does not belong to this bot directory.' }
    if ($Action -eq 'EnableAutostart') {
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
        Set-ScheduledTask -TaskName $name -Trigger $trigger | Out-Null
        $task = Get-ScheduledTask -TaskName $name
    } elseif ($Action -eq 'DisableAutostart') {
        foreach ($trigger in $task.Triggers) { $trigger.Enabled=$false }
        Set-ScheduledTask -InputObject $task | Out-Null
        $task = Get-ScheduledTask -TaskName $name
    }
    $autostart = @($task.Triggers | Where-Object { $_.Enabled }).Count -gt 0
    $result += @{ name=$name; state=[string]$task.State; autostart=$autostart }
}
@{ installed=$true; components=$result } | ConvertTo-Json -Depth 5 -Compress
