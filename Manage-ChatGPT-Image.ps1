param([ValidateSet('Ensure','Start','Stop','Restart','Status','Login','InstallExtension')][string]$Action='Status')
$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$localRoot=Join-Path $env:LOCALAPPDATA 'Xiaofeilong\ChatGPTImages'
$browserState=Join-Path $taskRoot 'data\chatgpt-image-browser.json'
$state=if(Test-Path -LiteralPath $browserState){Get-Content -LiteralPath $browserState -Raw -Encoding UTF8 | ConvertFrom-Json}else{$null}
$profile=if($state.userDataDirectory){[IO.Path]::GetFullPath([string]$state.userDataDirectory)}else{Join-Path $localRoot 'profile'}
$extension=Join-Path $taskRoot 'extensions\chatgpt-images'
function Get-ImageBrowser {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {$_.Name -eq 'chrome.exe' -and $_.CommandLine -like "*--user-data-dir=$profile*" -and $_.CommandLine -notmatch '\s--type='}
}
if($Action -eq 'Status') {
  [pscustomobject]@{installed=($null -ne $state -and (Test-Path -LiteralPath $state.executable));running=(@(Get-ImageBrowser).Count -gt 0)} | ConvertTo-Json -Compress
  exit
}
if($Action -in @('Stop','Restart')) {
  foreach($item in @(Get-ImageBrowser)){if($item.CommandLine -like "*--user-data-dir=$profile*"){Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue}}
  if($Action -eq 'Stop'){[pscustomobject]@{running=$false;enabled=$false}|ConvertTo-Json -Compress;exit}
}
if(-not $state -or -not (Test-Path -LiteralPath $state.executable)){throw 'Run Setup-ChatGPT-Images.ps1 first.'}
if(-not $state.userDataDirectory){
  $state | Add-Member -NotePropertyName userDataDirectory -NotePropertyValue $profile -Force
  [IO.File]::WriteAllText($browserState+'.tmp',($state|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath ($browserState+'.tmp') -Destination $browserState -Force
}
if($state.browserMode -eq 'installed') {
  $publisher=Get-AuthenticodeSignature -LiteralPath $state.executable
  if([IO.Path]::GetFileName($state.executable) -ne 'chrome.exe' -or $publisher.Status -ne 'Valid' -or $publisher.SignerCertificate.Subject -notmatch 'Google LLC'){throw 'Installed browser validation failed.'}
} else {
  if(-not ([IO.Path]::GetFullPath($state.executable)).StartsWith([IO.Path]::GetFullPath($localRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected browser path.'}
  if(-not $state.sha256 -or (Get-FileHash -LiteralPath $state.executable -Algorithm SHA256).Hash -ne $state.sha256){throw 'Browser file changed. Run setup again.'}
}
$manifest=Get-Content -LiteralPath (Join-Path $extension 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$key=[Convert]::FromBase64String($manifest.key)
$sha=[Security.Cryptography.SHA256]::Create();$digest=$sha.ComputeHash($key);$sha.Dispose()
$extensionId= -join ($digest[0..15] | ForEach-Object { [char](97+($_ -shr 4));[char](97+($_ -band 15)) })
if($Action -eq 'InstallExtension') {$target='chrome://extensions/'}
elseif($Action -eq 'Login') {
  $token=(Get-Content -LiteralPath (Join-Path $taskRoot 'data\chatgpt-image-token.txt') -Raw).Trim()
  $target="chrome-extension://$extensionId/options.html#$token"
  try {
    $panelToken=(Get-Content -LiteralPath (Join-Path $taskRoot 'data\viewer-token.txt') -Raw).Trim()
    Invoke-RestMethod -Uri 'http://127.0.0.1:6098/api/image-generation' -Method Post -Headers @{Authorization=('Bearer '+$panelToken)} -ContentType 'application/json' -Body '{"action":"save","browserEnabled":true}' -TimeoutSec 5 | Out-Null
  }catch{}
} else {$target='https://chatgpt.com/'}
$arguments=@(('"--user-data-dir='+$profile+'"'),'--no-first-run','--disable-session-crashed-bubble',$target)
if($state.browserMode -ne 'installed'){$arguments+=('"--load-extension='+$extension+'"')}
if(-not (Get-ImageBrowser) -or $Action -in @('Login','InstallExtension')) {
  & (Join-Path $taskRoot 'Keep-DevMode.ps1') -ProfilePath $profile | Out-Null
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  if($Action -in @('Login','InstallExtension')){Start-Process -FilePath $state.executable -WorkingDirectory (Split-Path $state.executable) -ArgumentList $arguments -WindowStyle Normal | Out-Null}
  else {Start-Process -FilePath $state.executable -WorkingDirectory (Split-Path $state.executable) -ArgumentList ($arguments+'--start-minimized') -WindowStyle Hidden | Out-Null}
}
if($Action -eq 'InstallExtension'){Start-Process explorer.exe -ArgumentList ('"'+$extension+'"') -WindowStyle Normal | Out-Null}
[pscustomobject]@{running=$true;enabled=$true}|ConvertTo-Json -Compress
