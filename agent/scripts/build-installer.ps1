param(
  [string]$Iscc = 'iscc.exe',
  [string]$Version = '0.1.0',
  [string]$Publisher = $(if ($env:WINDOWS_SIGNING_PUBLISHER) { $env:WINDOWS_SIGNING_PUBLISHER } else { 'Dokladovka' }),
  [string]$DownloadUrl,
  [switch]$Development,
  [switch]$TemporarySelfSigned,
  [string]$SelfSignedCertificateThumbprint,
  [string]$SelfSignedCertificatePath
)

$ErrorActionPreference = 'Stop'
if ($Development -and $TemporarySelfSigned) {
  throw 'Development a TemporarySelfSigned sa nedajú použiť naraz.'
}
$agentRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location (Join-Path $agentRoot 'installer')
try {
  $suffix = if ($Development) { '-UNSIGNED-DEV' } elseif ($TemporarySelfSigned) { '-SELF-SIGNED-TEMP' } else { '' }
  $isccArguments = @("/DAppVersion=$Version", "/DOutputSuffix=$suffix", "/DAppPublisher=$Publisher")
  if ($TemporarySelfSigned) {
    if (-not $SelfSignedCertificatePath -or -not (Test-Path -LiteralPath $SelfSignedCertificatePath)) {
      throw 'Dočasný self-signed build vyžaduje verejný certifikát.'
    }
    if ($SelfSignedCertificateThumbprint -notmatch '^[a-fA-F0-9]{40,64}$') {
      throw 'Dočasný self-signed build vyžaduje platný thumbprint.'
    }
    $isccArguments += "/DSelfSignedCertificatePath=$SelfSignedCertificatePath"
    $isccArguments += "/DSelfSignedCertificateThumbprint=$SelfSignedCertificateThumbprint"
  }
  & $Iscc @isccArguments 'Dokladovka.Agent.iss'
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup zlyhal s kódom $LASTEXITCODE." }
}
finally {
  Pop-Location
}
$expectedName = "Dokladovka-Agent-Setup-$Version$(if ($Development) { '-UNSIGNED-DEV' } elseif ($TemporarySelfSigned) { '-SELF-SIGNED-TEMP' }).exe"
$artifact = Get-Item -LiteralPath (Join-Path $agentRoot "artifacts\$expectedName") -ErrorAction SilentlyContinue
if (-not $artifact) { throw 'Inštalátor nebol vytvorený.' }
if (-not $Development -and -not $TemporarySelfSigned -and -not $env:AGENT_SIGNTOOL_COMMAND) {
  throw 'Produkčný inštalátor vyžaduje AGENT_SIGNTOOL_COMMAND. Pre lokálny build použite -Development.'
}
if ($TemporarySelfSigned) {
  $normalizedThumbprint = $SelfSignedCertificateThumbprint.Replace(' ', '').ToUpperInvariant()
  $certificate = Get-ChildItem -Path Cert:\CurrentUser\My |
    Where-Object { $_.Thumbprint -eq $normalizedThumbprint -and $_.HasPrivateKey } |
    Select-Object -First 1
  if (-not $certificate) { throw 'Self-signed certifikát s privátnym kľúčom nebol nájdený v Cert:\CurrentUser\My.' }
  $signed = Set-AuthenticodeSignature -LiteralPath $artifact.FullName -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
  if ($signed.Status -ne 'Valid') { throw "Dočasný Authenticode podpis nie je platný: $($signed.Status)." }
  $actualThumbprint = $certificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
} elseif (-not $Development) {
  & cmd.exe /d /s /c ($env:AGENT_SIGNTOOL_COMMAND.Replace('{file}', '"' + $artifact.FullName + '"'))
  if ($LASTEXITCODE -ne 0) { throw "Podpisovanie zlyhalo s kódom $LASTEXITCODE." }
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { throw 'Authenticode podpis nie je platný.' }
  $actualThumbprint = $signature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
  if ($env:WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT -and $actualThumbprint -ne $env:WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT.Replace(' ', '').ToUpperInvariant()) {
    throw 'Thumbprint podpísaného inštalátora sa nezhoduje s konfiguráciou.'
  }
} else {
  $actualThumbprint = $null
}
$artifact = Get-Item -LiteralPath $artifact.FullName
$hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($artifact.FullName + '.sha256') -Encoding ascii -Value "$hash  $($artifact.Name)"
$manifest = [ordered]@{
  available = -not $Development
  version = $Version
  downloadUrl = if ($Development) { $null } else { $DownloadUrl }
  sha256 = $hash
  fileSize = $artifact.Length
  publishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  publisher = $Publisher
  publisherThumbprint = $actualThumbprint
  minimumWindowsVersion = '10'
  signed = -not $Development
  signatureTrust = if ($TemporarySelfSigned) { 'self-signed' } elseif ($Development) { 'unsigned' } else { 'public' }
  certificateUrl = if ($TemporarySelfSigned) { '/downloads/Dokladovka-Agent-Temporary-Code-Signing.cer' } else { $null }
  channel = if ($Development) { 'development' } elseif ($TemporarySelfSigned) { 'temporary' } else { 'production' }
}
if ($TemporarySelfSigned) {
  if (-not $DownloadUrl -or ($DownloadUrl -notmatch '^/downloads/[A-Za-z0-9._-]+$' -and $DownloadUrl -notmatch '^https://')) {
    throw 'Dočasný self-signed manifest vyžaduje HTTPS alebo lokálnu /downloads/ URL.'
  }
} elseif (-not $Development) {
  if (-not $DownloadUrl -or -not [Uri]::IsWellFormedUriString($DownloadUrl, [UriKind]::Absolute) -or -not $DownloadUrl.StartsWith('https://')) {
    throw 'Produkčný manifest vyžaduje platnú HTTPS DownloadUrl.'
  }
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $agentRoot 'artifacts\release-manifest.json') -Encoding utf8
Write-Host "$($artifact.FullName) ($hash)"
