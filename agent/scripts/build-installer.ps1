param(
  [string]$Iscc = 'iscc.exe'
)

$ErrorActionPreference = 'Stop'
$agentRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location (Join-Path $agentRoot 'installer')
try {
  & $Iscc 'Dokladovka.Agent.iss'
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup zlyhal s kódom $LASTEXITCODE." }
}
finally {
  Pop-Location
}
$artifact = Get-ChildItem (Join-Path $agentRoot 'artifacts\dokladovka-agent-setup-*.exe') | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $artifact) { throw 'Inštalátor nebol vytvorený.' }
if ($env:AGENT_SIGNTOOL_COMMAND) {
  & cmd.exe /d /s /c ($env:AGENT_SIGNTOOL_COMMAND.Replace('{file}', '"' + $artifact.FullName + '"'))
  if ($LASTEXITCODE -ne 0) { throw "Podpisovanie zlyhalo s kódom $LASTEXITCODE." }
}
$hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($artifact.FullName + '.sha256') -Encoding ascii -Value "$hash  $($artifact.Name)"
Write-Host "$($artifact.FullName) ($hash)"
