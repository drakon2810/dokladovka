param(
  [ValidateSet('win-x64', 'win-arm64')]
  [string]$Runtime = 'win-x64',
  [string]$Dotnet = 'dotnet',
  [string]$Version = '0.1.0',
  [string]$CloudBaseUrl = $(if ($env:AGENT_CLOUD_BASE_URL) { $env:AGENT_CLOUD_BASE_URL } else { 'https://app.dokladorpro.sk' }),
  [string]$PublisherThumbprint = $env:WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT
)

$ErrorActionPreference = 'Stop'
$agentRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$schemas = Join-Path $agentRoot 'vendor\pohoda-xsd'
& (Join-Path $PSScriptRoot 'fetch-pohoda-xsd.ps1') -Destination $schemas
$output = Join-Path $agentRoot "publish\$Runtime"
$agentStaging = Join-Path $agentRoot "src\Dokladovka.Agent\bin\Release\net8.0-windows\$Runtime\publish"
$configuratorStaging = Join-Path $agentRoot "src\Dokladovka.Agent.Configurator\bin\Release\net8.0-windows\$Runtime\publish"
Push-Location $agentRoot
try {
  & $Dotnet publish 'src\Dokladovka.Agent\Dokladovka.Agent.csproj' `
    --configuration Release --runtime $Runtime --self-contained true `
    -p:Version=$Version
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish zlyhal s kódom $LASTEXITCODE." }
  & $Dotnet publish 'src\Dokladovka.Agent.Configurator\Dokladovka.Agent.Configurator.csproj' `
    --configuration Release --runtime $Runtime --self-contained true `
    -p:Version=$Version
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish konfigurátora zlyhal s kódom $LASTEXITCODE." }
}
finally {
  Pop-Location
}
$agentRootFull = [System.IO.Path]::GetFullPath($agentRoot.Path).TrimEnd('\') + '\'
$outputFull = [System.IO.Path]::GetFullPath($output)
if (-not $outputFull.StartsWith($agentRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Výstup publish je mimo agent workspace: $outputFull"
}
if (Test-Path -LiteralPath $outputFull) { Remove-Item -LiteralPath $outputFull -Recurse -Force }
New-Item -ItemType Directory -Path $outputFull | Out-Null
Copy-Item -Path (Join-Path $agentStaging '*') -Destination $outputFull -Recurse -Force
Copy-Item -Path (Join-Path $configuratorStaging '*') -Destination $outputFull -Recurse -Force
Copy-Item -LiteralPath $schemas -Destination (Join-Path $output 'Schemas') -Recurse -Force
$defaults = [ordered]@{
  cloudBaseUrl = $CloudBaseUrl
  mServerUrl = 'http://localhost:444'
  publisherThumbprint = if ($PublisherThumbprint) { $PublisherThumbprint.Replace(' ', '').ToUpperInvariant() } else { $null }
}
$defaults | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'agent-defaults.json') -Encoding utf8
Write-Host "Agent publikovaný: $output"
