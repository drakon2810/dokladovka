param(
  [ValidateSet('win-x64', 'win-arm64')]
  [string]$Runtime = 'win-x64',
  [string]$Dotnet = 'dotnet'
)

$ErrorActionPreference = 'Stop'
$agentRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$schemas = Join-Path $agentRoot 'vendor\pohoda-xsd'
& (Join-Path $PSScriptRoot 'fetch-pohoda-xsd.ps1') -Destination $schemas
$output = Join-Path $agentRoot "publish\$Runtime"
Push-Location $agentRoot
try {
  & $Dotnet publish 'src\Dokladovka.Agent\Dokladovka.Agent.csproj' `
    --configuration Release --runtime $Runtime --self-contained true
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish zlyhal s kódom $LASTEXITCODE." }
}
finally {
  Pop-Location
}
$defaultOutput = Join-Path $agentRoot "src\Dokladovka.Agent\bin\Release\net8.0-windows\$Runtime\publish"
$agentRootFull = [System.IO.Path]::GetFullPath($agentRoot.Path).TrimEnd('\') + '\'
$outputFull = [System.IO.Path]::GetFullPath($output)
if (-not $outputFull.StartsWith($agentRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Výstup publish je mimo agent workspace: $outputFull"
}
if (Test-Path -LiteralPath $outputFull) { Remove-Item -LiteralPath $outputFull -Recurse -Force }
New-Item -ItemType Directory -Path $outputFull | Out-Null
Copy-Item -Path (Join-Path $defaultOutput '*') -Destination $outputFull -Recurse -Force
Copy-Item -LiteralPath $schemas -Destination (Join-Path $output 'Schemas') -Recurse -Force
Write-Host "Agent publikovaný: $output"
