param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
. (Join-Path $taskRoot 'QQ-Risk-Control.ps1')
$risk = Get-QQRiskState -Root $taskRoot
if (-not $risk.paused -and $Apply) {
    throw '必须先启用 QQ 风控暂停，才能在 QQ 未运行时修改 NapCat 安全配置。'
}

$configDir = Join-Path $taskRoot 'runtime\napcat\config'
$files = @(Get-ChildItem -LiteralPath $configDir -Filter 'napcat*.json' -File -ErrorAction Stop |
    Where-Object { $_.BaseName -match '^napcat(?:_\d+)?$' })
if (-not $files.Count) { throw '未找到 NapCat 配置。' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $taskRoot ('data\risk-backups\napcat-security-' + $stamp)
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$changes = @()

foreach ($file in $files) {
    $config = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $before = [pscustomobject]@{
        o3HookMode = $config.o3HookMode
        hook = $config.bypass.hook
        window = $config.bypass.window
        module = $config.bypass.module
        process = $config.bypass.process
        container = $config.bypass.container
        js = $config.bypass.js
    }
    if ($Apply) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $backup $file.Name) -Force
        $config | Add-Member -NotePropertyName o3HookMode -NotePropertyValue 0 -Force
        if ($null -eq $config.bypass) {
            $config | Add-Member -NotePropertyName bypass -NotePropertyValue ([pscustomobject]@{}) -Force
        }
        foreach ($name in @('hook', 'window', 'module', 'process', 'container', 'js')) {
            $config.bypass | Add-Member -NotePropertyName $name -NotePropertyValue $false -Force
        }
        $temp = $file.FullName + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        $config | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $temp -Encoding UTF8
        Move-Item -LiteralPath $temp -Destination $file.FullName -Force
    }
    $changes += [pscustomobject]@{
        file = $file.Name
        before = $before
        after = if ($Apply) {
            [pscustomobject]@{
                o3HookMode = 0
                hook = $false
                window = $false
                module = $false
                process = $false
                container = $false
                js = $false
            }
        } else { $null }
    }
}

if ($Apply) {
    @{
        appliedAt = (Get-Date).ToString('o')
        backup = $backup.Substring($taskRoot.Length + 1)
        files = $changes
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $backup 'manifest.json') -Encoding UTF8
}

@{ applied = [bool]$Apply; backup = if ($Apply) { $backup.Substring($taskRoot.Length + 1) } else { $null }; files = $changes } |
    ConvertTo-Json -Depth 10
