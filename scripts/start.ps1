param(
  [ValidateSet("dev", "prod")]
  [string]$Mode = "prod"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path ".\\logs" | Out-Null

if (-not (Test-Path ".\\node_modules\\.bin\\pm2.cmd")) {
  throw "pm2 is not installed. Run npm install first."
}

$script = if ($Mode -eq "dev") { "pm2:dev" } else { "pm2:prod" }
npm run $script
npm run pm2:status
