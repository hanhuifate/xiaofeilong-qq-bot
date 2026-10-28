param([string]$ProfilePath = (Join-Path $env:LOCALAPPDATA 'Xiaofeilong\ChatGPTImages\profile'))
$ErrorActionPreference = 'Stop'
$prefs = Join-Path $ProfilePath 'Default\Preferences'
if (-not (Test-Path -LiteralPath $prefs)) { exit 0 }
# Skip while Chrome is running: Chrome owns this file and would overwrite the change.
$running = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*--user-data-dir=$ProfilePath*" -and $_.CommandLine -notmatch '\s--type=' })
if ($running.Count -gt 0) { exit 0 }
$node = @('D:\nodejs\node.exe', (Get-Command node.exe -ErrorAction SilentlyContinue).Source) |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $node) { exit 0 }
$code = "const fs=require('fs');const p=process.argv[1];let s=fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');let j;try{j=JSON.parse(s);}catch(e){console.log('prefs unreadable: '+e.message);process.exit(0);}j.extensions=j.extensions||{};const ui=j.extensions.ui=j.extensions.ui||{};if(ui.developer_mode!==true){ui.developer_mode=true;fs.writeFileSync(p+'.keepdev.tmp',JSON.stringify(j));fs.renameSync(p+'.keepdev.tmp',p);console.log('developer_mode enabled');}else{console.log('developer_mode already on');}"
& $node -e $code $prefs
