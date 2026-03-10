param(
  [ValidateSet("start", "restart", "stop", "status", "logs")]
  [string]$Action = "status",

  [ValidateSet("dev", "prod")]
  [string]$Mode = "prod",

  [int]$HealthPort = 3210,

  [int]$HealthTimeoutSeconds = 30,

  [int]$LogLines = 120
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pm2 = Join-Path $root "node_modules\.bin\pm2.cmd"
if (-not (Test-Path $pm2)) {
  throw "pm2 is not installed. Run npm install first."
}

function Invoke-Pm2 {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  & $pm2 @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "pm2 command failed: $($Arguments -join ' ')"
  }
}

function Wait-ForHealth {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $url = "http://127.0.0.1:$Port/api/health"

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        return $response.Content
      }
    } catch {
      Start-Sleep -Milliseconds 700
    }
  }

  throw "Health check did not pass within $TimeoutSeconds seconds at $url"
}

switch ($Action) {
  "start" {
    $appName = if ($Mode -eq "dev") { "codex-web-term-dev" } else { "codex-web-term" }
    Invoke-Pm2 -Arguments @("startOrReload", "ecosystem.config.cjs", "--only", $appName, "--update-env")
    $health = Wait-ForHealth -Port $HealthPort -TimeoutSeconds $HealthTimeoutSeconds
    Write-Host "Service started successfully."
    Write-Host $health
    Invoke-Pm2 -Arguments @("status")
    break
  }

  "restart" {
    $appName = if ($Mode -eq "dev") { "codex-web-term-dev" } else { "codex-web-term" }
    Invoke-Pm2 -Arguments @("startOrReload", "ecosystem.config.cjs", "--only", $appName, "--update-env")
    $health = Wait-ForHealth -Port $HealthPort -TimeoutSeconds $HealthTimeoutSeconds
    Write-Host "Service restarted successfully."
    Write-Host $health
    Invoke-Pm2 -Arguments @("status")
    break
  }

  "stop" {
    Invoke-Pm2 -Arguments @("delete", "codex-web-term", "codex-web-term-dev")
    Write-Host "Service stopped."
    break
  }

  "status" {
    Invoke-Pm2 -Arguments @("status")
    try {
      $health = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$HealthPort/api/health" -TimeoutSec 3
      Write-Host $health.Content
    } catch {
      Write-Host "Health endpoint is not reachable on port $HealthPort."
    }
    break
  }

  "logs" {
    Invoke-Pm2 -Arguments @("logs", "codex-web-term", "--lines", "$LogLines")
    break
  }
}
