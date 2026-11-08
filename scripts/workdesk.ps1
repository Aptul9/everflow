# Workdesk launcher, run from anywhere:
#   .\scripts\workdesk.ps1 build    builds this checkout and pins the new build to the instance
#   .\scripts\workdesk.ps1 start | stop | status | open
# The instance folder holds config.toml, the database and build.txt (the pinned build receipt).
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('build', 'start', 'stop', 'status', 'open')][string]$Command,
  [string]$Instance = (Join-Path $env:LOCALAPPDATA 'workdesk')
)
$ErrorActionPreference = 'Stop'
$config = Join-Path $Instance 'config.toml'
$pin = Join-Path $Instance 'build.txt'
if (-not (Test-Path -LiteralPath $config)) { throw "No config.toml in $Instance" }

function Invoke-Cli([string[]]$arguments) {
  if (-not (Test-Path -LiteralPath $pin)) { throw "No pinned build: run '.\scripts\workdesk.ps1 build' first" }
  $receipt = (Get-Content -LiteralPath $pin -Raw).Trim()
  & node (Join-Path (Split-Path $receipt) 'dist/cli.js') --artifact $receipt --config $config @arguments
  if ($LASTEXITCODE -ne 0) { throw "workdesk $($arguments[0]) failed ($LASTEXITCODE)" }
}

switch ($Command) {
  'build' {
    Push-Location (Split-Path $PSScriptRoot)
    try { & npm run build | Tee-Object -Variable lines; if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" } }
    finally { Pop-Location }
    $receipt = ($lines | Where-Object { $_ -match '"buildReceipt"' } | Select-Object -Last 1 | ConvertFrom-Json).buildReceipt
    if (-not $receipt) { throw 'Build printed no buildReceipt' }
    Set-Content -LiteralPath $pin -Value $receipt
    "Pinned $receipt; restart the instance to use it."
  }
  'open' {
    $state = Invoke-Cli @('status') | ConvertFrom-Json
    if (-not $state.running) { throw 'Workdesk is not running' }
    Start-Process "http://127.0.0.1:$($state.port)/"
  }
  default { Invoke-Cli @($Command) }
}
