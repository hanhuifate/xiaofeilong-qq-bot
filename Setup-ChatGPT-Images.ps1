param([switch]$NoLogin,[switch]$UseInstalledChrome)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$taskRoot=$PSScriptRoot
$localRoot=Join-Path $env:LOCALAPPDATA 'Xiaofeilong\ChatGPTImages'
$stateFile=Join-Path $taskRoot 'data\chatgpt-image-browser.json'
New-Item -ItemType Directory -Force -Path $localRoot | Out-Null
if($UseInstalledChrome) {
  $candidates=@(Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique)
  $candidates+=@(Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  $installed=$null
  foreach($candidate in $candidates){if($candidate -and (Test-Path -LiteralPath $candidate)){ $sig=Get-AuthenticodeSignature -LiteralPath $candidate;if($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match 'Google LLC'){$installed=$candidate;break} }}
  if(-not $installed){throw 'An installed, signed Google Chrome browser was not found.'}
  New-Item -ItemType Directory -Force -Path (Split-Path $stateFile) | Out-Null
  [pscustomobject]@{executable=$installed;browserMode='installed';sha256=(Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash}|ConvertTo-Json|Set-Content -LiteralPath $stateFile -Encoding UTF8
  if(-not $NoLogin){& (Join-Path $taskRoot 'Manage-ChatGPT-Image.ps1') -Action InstallExtension}
  Write-Output 'Installed Chrome selected. Load the local extension once, then use the ChatGPT login button.'
  exit
}
if(Test-Path -LiteralPath $stateFile){$existingState=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json;if($existingState.browserMode -eq 'installed'){if(-not $NoLogin){& (Join-Path $taskRoot 'Manage-ChatGPT-Image.ps1') -Action Login};exit}}
# Official Chrome for Testing supports unpacked extensions without changing the
# user's normal Chrome or enabling a remote debugging port.
$releases=Invoke-RestMethod -Uri 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
$release=$releases.channels.Stable
$download=$release.downloads.chrome | Where-Object platform -eq 'win64' | Select-Object -First 1
if($download.url -notmatch '^https://storage\.googleapis\.com/chrome-for-testing-public/[0-9.]+/win64/chrome-win64\.zip$'){throw 'Unexpected official browser download URL.'}
$versionRoot=Join-Path $localRoot ('browser\'+$release.version)
$executable=Join-Path $versionRoot 'chrome-win64\chrome.exe'
$verifiedInstall=$false
if((Test-Path -LiteralPath $stateFile) -and (Test-Path -LiteralPath $executable)) {
  try {$previous=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json;$verifiedInstall=$previous.executable -eq $executable -and $previous.sha256 -eq (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash}catch{}
}
if(-not $verifiedInstall) {
  $archive=Join-Path $localRoot ('chrome-'+$release.version+'.zip')
  $metadata=Invoke-WebRequest -Method Head -Uri $download.url -UseBasicParsing
  $expectedLength=[long]$metadata.Headers['Content-Length']
  $existing=if(Test-Path -LiteralPath $archive){(Get-Item -LiteralPath $archive).Length}else{0}
  if($existing -ne $expectedLength) {
    $downloading=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'curl.exe' -and $_.CommandLine -like "*$archive*" }
    if($downloading){Write-Output 'Official browser download is still running. Please wait and open this login launcher again.';exit 0}
    Write-Output 'Downloading official Chrome for Testing. Existing logins are preserved.'
    Invoke-WebRequest -Uri $download.url -OutFile $archive -UseBasicParsing
  }
  $hashHeader= -join @($metadata.Headers['x-goog-hash'])
  if($hashHeader -notmatch 'md5=([^,\s]+)'){throw 'Official archive hash is missing.'}
  $expectedMD5=$Matches[1]
  $digest=[Security.Cryptography.MD5]::Create();$stream=[IO.File]::OpenRead($archive)
  try{$actualMD5=[Convert]::ToBase64String($digest.ComputeHash($stream))}finally{$digest.Dispose();$stream.Dispose()}
  if($actualMD5 -ne $expectedMD5){throw 'Official archive checksum mismatch; no browser was started.'}
  Expand-Archive -LiteralPath $archive -DestinationPath $versionRoot -Force
}
$signature=Get-AuthenticodeSignature -LiteralPath $executable
# Google documents that Chrome for Testing binaries are unsigned (CfT issue
# 205). Verify the official archive above; do not mistake NotSigned for a bad
# signature, and do not accept an actually invalid signature if one is present.
if($signature.Status -notin @('Valid','NotSigned')){throw 'Browser signature is invalid.'}
if($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -notmatch 'Google LLC'){throw 'Unexpected browser publisher.'}
if((Get-Item -LiteralPath $executable).VersionInfo.FileVersion -ne $release.version){throw 'Official browser version mismatch.'}
New-Item -ItemType Directory -Force -Path (Split-Path $stateFile) | Out-Null
[pscustomobject]@{executable=$executable;version=$release.version;sha256=(Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash;source=$download.url}|ConvertTo-Json|Set-Content -LiteralPath $stateFile -Encoding UTF8
if(-not $NoLogin){& (Join-Path $taskRoot 'Manage-ChatGPT-Image.ps1') -Action Login}
Write-Output 'ChatGPT image browser installed.'
