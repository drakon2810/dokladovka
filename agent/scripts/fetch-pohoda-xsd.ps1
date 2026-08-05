param(
  [string]$Destination = (Join-Path $PSScriptRoot '..\vendor\pohoda-xsd')
)

$ErrorActionPreference = 'Stop'
$source = 'https://www.stormware.cz/xml/schema/all_schema_ver2.zip'
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("pohoda-xsd-" + [guid]::NewGuid().ToString('N'))
$archive = "$temporary.zip"
try {
  Invoke-WebRequest -Uri $source -OutFile $archive -UseBasicParsing
  New-Item -ItemType Directory -Path $temporary | Out-Null
  # Expand-Archive namiesto [IO.Compression.ZipFile] — rovnaký cmdlet funguje
  # v Windows PowerShell 5.1 aj v pwsh na Linuxe, takže ten istý skript vie
  # schémy stiahnuť pre oba CI workflowy (ubuntu `npm test` aj windows `dotnet test`).
  Expand-Archive -LiteralPath $archive -DestinationPath $temporary -Force
  foreach ($required in @('data.xsd', 'type.xsd', 'invoice.xsd', 'voucher.xsd')) {
    if (-not (Test-Path -LiteralPath (Join-Path $temporary $required))) {
      throw "Oficiálny balík POHODA neobsahuje $required."
    }
  }
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  New-Item -ItemType Directory -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $temporary '*.xsd') -Destination $Destination
  $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath (Join-Path $Destination 'SOURCE.txt') -Encoding utf8 -Value @(
    "URL=$source"
    "SHA256=$hash"
    "FETCHED_AT=$([DateTimeOffset]::UtcNow.ToString('O'))"
  )
  Write-Host "POHODA XSD: $Destination ($hash)"
}
finally {
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
