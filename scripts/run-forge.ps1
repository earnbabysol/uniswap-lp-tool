param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ForgeArgs
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$bundledForge = Join-Path $env:TEMP 'codex-foundry-v1.7.1\forge.exe'
$forge = if (Get-Command forge -ErrorAction SilentlyContinue) {
  (Get-Command forge).Source
} elseif (Test-Path -LiteralPath $bundledForge) {
  $bundledForge
} else {
  throw 'forge is not installed. Install Foundry stable from https://getfoundry.sh and retry.'
}

Push-Location (Join-Path $repoRoot 'contracts')
try {
  & $forge @ForgeArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
