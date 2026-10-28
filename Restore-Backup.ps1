param([string]$BackupPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
$taskRoot = $PSScriptRoot
if (-not $BackupPath) {
    $dialog = New-Object Microsoft.Win32.OpenFileDialog
    $dialog.Title = '选择大肥龙 SQLite 备份'
    $dialog.Filter = 'SQLite 备份|*.sqlite3'
    $dialog.InitialDirectory = Join-Path $taskRoot 'data\backups'
    if (-not $dialog.ShowDialog()) { exit 0 }
    $BackupPath = $dialog.FileName
}
$backupFullPath = (Resolve-Path -LiteralPath $BackupPath).Path
$adminScript = Join-Path $taskRoot 'storage-admin.mjs'
$inspection = & node.exe $adminScript inspect $backupFullPath
if ($LASTEXITCODE -ne 0) { [Windows.MessageBox]::Show('这不是有效的大肥龙备份，当前数据没有改动。','恢复备份') | Out-Null; exit 1 }
$info = $inspection | ConvertFrom-Json
$message = "将恢复备份 $($info.file)，包含 $($info.events) 条聊天记录。`n当前数据库会先完整备份；已删除的数据不会因恢复而重新启用。恢复会重置后续模型上下文，不删除 Codex 软件的旧聊天。`n是否继续？"
if ([Windows.MessageBox]::Show($message,'确认恢复','YesNo','Warning') -ne 'Yes') { exit 0 }
try {
    & (Join-Path $taskRoot 'Stop.ps1') | Out-Null
    $result = & node.exe $adminScript restore $backupFullPath
    if ($LASTEXITCODE -ne 0) { throw '恢复失败，当前数据的保护副本仍保留在 backups 目录。' }
    [Windows.MessageBox]::Show('本机数据库已恢复，正在重新启动回复服务。','恢复完成') | Out-Null
} catch {
    [Windows.MessageBox]::Show($_.Exception.Message,'恢复未完成') | Out-Null
} finally {
    & (Join-Path $taskRoot 'Start.ps1') | Out-Null
}
