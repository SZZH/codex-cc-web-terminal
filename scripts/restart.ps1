param(
  [ValidateSet("dev", "prod")]
  [string]$Mode = "prod"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path ".\\logs" | Out-Null

if ($Mode -eq "dev") {
  npm run pm2:dev
} else {
  npm run pm2:prod
}

npm run pm2:status
