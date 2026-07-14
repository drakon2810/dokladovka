param(
  [string]$Version = '0.1.0',
  [string]$Iscc = 'iscc.exe',
  [string]$CloudBaseUrl = 'http://localhost:3001',
  [string]$Publisher = 'Dokladovka – DOČASNÝ SELF-SIGNED',
  [int]$ValidityMonths = 12
)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version musí mať tvar 1.2.3.' }
if ($ValidityMonths -lt 1 -or $ValidityMonths -gt 24) { throw 'ValidityMonths musí byť od 1 do 24.' }

$agentRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$artifacts = Join-Path $agentRoot 'artifacts'
$publicDownloads = Join-Path (Split-Path $agentRoot -Parent) 'public\downloads'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null
New-Item -ItemType Directory -Path $publicDownloads -Force | Out-Null

$subject = 'CN=Dokladovka Temporary Self-Signed Code Signing'
$certificate = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object {
    $_.Subject -eq $subject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(30) -and
    $_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3'
  } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $certificate) {
  $certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -FriendlyName 'Dokladovka temporary code signing' `
    -CertStoreLocation Cert:\CurrentUser\My `
    -NotAfter (Get-Date).AddMonths($ValidityMonths) `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable
}

$thumbprint = $certificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
$certificatePath = Join-Path $artifacts 'Dokladovka-Agent-Temporary-Code-Signing.cer'
Export-Certificate -Cert $certificate -FilePath $certificatePath -Force | Out-Null

foreach ($store in @('Root', 'TrustedPublisher')) {
  if (-not (Test-Path -LiteralPath "Cert:\CurrentUser\$store\$thumbprint")) {
    Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\CurrentUser\$store" | Out-Null
  }
}

$env:WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT = $thumbprint
$env:WINDOWS_SIGNING_PUBLISHER = $Publisher
& (Join-Path $PSScriptRoot 'publish.ps1') `
  -Runtime win-x64 `
  -Version $Version `
  -CloudBaseUrl $CloudBaseUrl `
  -PublisherThumbprint $thumbprint
if ($LASTEXITCODE -ne 0) { throw "Publish agenta zlyhal s kódom $LASTEXITCODE." }

$setupName = "Dokladovka-Agent-Setup-$Version-SELF-SIGNED-TEMP.exe"
& (Join-Path $PSScriptRoot 'build-installer.ps1') `
  -Iscc $Iscc `
  -Version $Version `
  -Publisher $Publisher `
  -DownloadUrl "/downloads/$setupName" `
  -TemporarySelfSigned `
  -SelfSignedCertificateThumbprint $thumbprint `
  -SelfSignedCertificatePath $certificatePath
if ($LASTEXITCODE -ne 0) { throw "Build inštalátora zlyhal s kódom $LASTEXITCODE." }

$files = @(
  $setupName,
  "$setupName.sha256",
  'Dokladovka-Agent-Temporary-Code-Signing.cer',
  'release-manifest.json'
)
foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $artifacts $file) -Destination (Join-Path $publicDownloads $file) -Force
}

$setupPath = Join-Path $artifacts $setupName
$signature = Get-AuthenticodeSignature -LiteralPath $setupPath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $thumbprint) {
  throw 'Záverečná kontrola self-signed podpisu zlyhala.'
}

Write-Host "Dočasný self-signed release je pripravený: $setupPath"
Write-Host "Thumbprint: $thumbprint"
Write-Host 'Prvé spustenie na inom počítači môže zobraziť Windows SmartScreen. Po povolení setup nainštaluje dočasný certifikát iba pre tento účet/počítač.'
