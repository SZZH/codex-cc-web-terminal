param(
  [switch]$ForceStart
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pm2 = Join-Path $root "node_modules\.bin\pm2.cmd"
$logsDir = Join-Path $root "logs"

if (-not (Test-Path $pm2)) {
  throw "pm2 is not installed at $pm2"
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
Set-Location $root

& $pm2 ping | Out-Null
& $pm2 resurrect | Out-Null

$apps = @()
try {
  $json = & $pm2 jlist
  if ($json) {
    $apps = $json | ConvertFrom-Json
  }
} catch {
  $apps = @()
}

$target = $apps | Where-Object { $_.name -eq "codex-web-term" }
if (-not $target -or $ForceStart) {
  & $pm2 startOrReload ecosystem.config.cjs --only codex-web-term --update-env | Out-Null
}

& $pm2 save | Out-Null
