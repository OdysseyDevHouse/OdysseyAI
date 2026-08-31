# ============================================================
#  update-on-server.ps1  -  runs ON THE SERVER (called by update.bat)
# ------------------------------------------------------------
#  Deploys the staged build into -Target and restarts the app.
#  Preserves the server's app\.env and app\uploads.
# ============================================================
param(
  # Where the live app lives. $Target\site is the IIS site's physical path;
  # $Target\app is what actually serves every byte, behind the proxy.
  #
  # A parameter rather than a constant so this whole script can be rehearsed
  # against a scratch directory — which is the only way to find out what it
  # does to an EXISTING install before it does it to the live one.
  [string]$Target = 'C:\inetpub\odyssey_ai'
)

$ErrorActionPreference = 'Stop'

$target = $Target

# ---- PM2 gets its own home, deliberately -------------------
# This VM also runs Odyssey_bind, whose deploy script calls `pm2 kill`. PM2 has
# ONE daemon per PM2_HOME no matter where the binary is installed, so with the
# default home that command would take OdysseyAI down as collateral — silently,
# and only noticed when a customer rang. Giving this app its own home makes the
# two deploys genuinely independent.
$env:PM2_HOME = Join-Path $target '.pm2'

# PM2 prints warnings and status to stderr (for instance "No process found"
# when nothing is running yet). Under $ErrorActionPreference='Stop' PowerShell
# promotes that stderr line to a terminating NativeCommandError and aborts the
# whole deploy. Route every PM2 call through this helper so its stderr stays
# informational.
# Tree copies go through robocopy: it is faster on the ~10,000 files this moves,
# and it does not treat the [bracketed] filenames all through Next's output as
# wildcard syntax the way Copy-Item's -Path does.
function Invoke-Robocopy {
  param([string]$From, [string]$To, [string[]]$Extra = @())
  # robocopy signals success with 0-7 and failure with 8+, so PowerShell 7's
  # native-command error handling would abort on a perfectly good copy.
  $prev = $null
  if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $prev = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }
  try {
    & robocopy $From $To /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2 @Extra | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE): $From -> $To" }
    $global:LASTEXITCODE = 0
  } finally {
    if ($null -ne $prev) { $PSNativeCommandUseErrorActionPreference = $prev }
  }
}

function Invoke-Pm2 {
  param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(ValueFromRemainingArguments)][string[]]$PmArgs
  )
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Exe @PmArgs } finally { $ErrorActionPreference = $old }
}

$staged     = $PSScriptRoot                       # this folder (the copied 'staged')
$appStaged  = Join-Path $staged 'app'
$pm2Staged  = Join-Path $staged 'pm2'
$siteStaged = Join-Path $staged 'site'

$appLive    = Join-Path $target 'app'
$pm2Live    = Join-Path $target 'pm2'
$siteLive   = Join-Path $target 'site'

Write-Host "Deploying to $target" -ForegroundColor Cyan

if (-not (Test-Path $appStaged) -or -not (Test-Path $pm2Staged)) {
  throw "Staged files not found. Run deploy-local.ps1 on your PC and copy the 'staged' folder here first."
}

New-Item -ItemType Directory -Path $target -Force | Out-Null

# --- 1. Stop the running app --------------------------------
# The Node process uses the app folder as its working directory, which locks it
# against deletion. Everything must let go before the swap.
Write-Host "[1/5] Stopping the app..." -ForegroundColor Yellow
$pm2Cmd = Join-Path $pm2Live 'node_modules\.bin\pm2.cmd'
if (Test-Path $pm2Cmd) {
  # `pm2 delete`, never `pm2 kill`.
  #
  # kill stops the DAEMON and therefore every app under it. That is only safe
  # while this app is the sole occupant of its PM2_HOME — which is how it is
  # designed, and which was not enough: on the real server, publishing either
  # app was observed to stop the other. Whatever the two installs are actually
  # sharing there, an app-scoped command cannot cause it.
  #
  # Nothing is lost by the change. The lock this step exists to release is held
  # by the Next process, whose working directory is the app folder — and delete
  # stops that process. The daemon's own cwd is elsewhere and never blocked the
  # swap.
  Invoke-Pm2 $pm2Cmd delete odyssey-ai *> $null
}
# Fallback for anything the daemon did not own.
#
# Matched on the app folder itself, not on the string "odyssey_ai". The looser
# match would also hit the PM2 daemon, whose command line carries its PM2_HOME
# (…\odyssey_ai\.pm2) — and stopping the daemon is exactly what the step above
# no longer does. Narrow enough that no other application's node process, in
# either direction, can be caught by it.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$appLive*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# --- 2. Stash what belongs to the server --------------------
# .env holds the live credentials and is never shipped; uploads holds customer
# paperwork that only exists here. A deploy that loses either is not a
# recoverable mistake.
Write-Host "[2/5] Preserving .env and uploads..." -ForegroundColor Yellow
$tmpEnv     = Join-Path $env:TEMP 'odyssey_ai.env.bak'
$tmpUploads = Join-Path $env:TEMP 'odyssey_ai.uploads.bak'
if (Test-Path (Join-Path $appLive '.env')) {
  Copy-Item (Join-Path $appLive '.env') $tmpEnv -Force
}
if (Test-Path (Join-Path $appLive 'uploads')) {
  if (Test-Path $tmpUploads) { Remove-Item $tmpUploads -Recurse -Force }
  Copy-Item (Join-Path $appLive 'uploads') $tmpUploads -Recurse
}

# --- 3. Swap in the new app ---------------------------------
Write-Host "[3/5] Updating app..." -ForegroundColor Yellow
if (Test-Path $appLive) {
  # Retry: file handles can take a moment to release after a process stops.
  $removed = $false
  for ($i = 0; $i -lt 5 -and -not $removed; $i++) {
    try { Remove-Item $appLive -Recurse -Force -ErrorAction Stop; $removed = $true }
    catch { Start-Sleep -Seconds 2 }
  }
  if (-not $removed) {
    throw "Could not remove $appLive - a process is still using it. Stop it (Task Manager -> node.exe) and re-run update.bat."
  }
}
Invoke-Robocopy $appStaged $appLive

# PM2 itself, and the IIS rewrite rule. Both are cheap to replace wholesale.
if (Test-Path $pm2Live) { Remove-Item $pm2Live -Recurse -Force }
Invoke-Robocopy $pm2Staged $pm2Live
New-Item -ItemType Directory -Path $siteLive -Force | Out-Null
Copy-Item (Join-Path $siteStaged 'web.config') $siteLive -Force

# Put the server's own files back.
if (Test-Path $tmpEnv)     { Copy-Item $tmpEnv (Join-Path $appLive '.env') -Force }
if (Test-Path $tmpUploads) { Copy-Item $tmpUploads (Join-Path $appLive 'uploads') -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $appLive 'uploads') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $appLive 'logs')    -Force | Out-Null

if (-not (Test-Path (Join-Path $appLive '.env'))) {
  Write-Host "  WARNING: no app\.env found on the server yet." -ForegroundColor Red
  Write-Host "           Copy $appLive\.env.example to $appLive\.env and fill it in" -ForegroundColor Red
  Write-Host "           before the app can reach a database." -ForegroundColor Red
}

# --- 4. Start the app ---------------------------------------
# No npm install: node_modules was traced and copied on your PC and ships
# inside 'staged', so the server needs no access to the npm registry.
Write-Host "[4/5] Starting the app (PM2)..." -ForegroundColor Yellow
$pm2Cmd = Join-Path $pm2Live 'node_modules\.bin\pm2.cmd'
if (-not (Test-Path $pm2Cmd)) {
  throw "Bundled PM2 not found at $pm2Cmd. Re-run deploy-local.ps1 on your PC."
}
Push-Location $appLive
# A clean start, not a restart. `pm2 restart` reuses the daemon's CACHED
# environment, so an edited .env or a changed PORT would not take effect and
# the deploy would look successful while running the old settings.
Invoke-Pm2 $pm2Cmd delete odyssey-ai *> $null
Invoke-Pm2 $pm2Cmd start ecosystem.config.js --update-env
Invoke-Pm2 $pm2Cmd save
Pop-Location

# --- 5. Prove it answers ------------------------------------
# Against localhost, not the public URL. That is the one comparison that
# separates "IIS is not proxying" from "the app did not start" - both look
# like the same failure from a browser.
Write-Host "[5/5] Checking http://127.0.0.1:4100/api/health ..." -ForegroundColor Yellow
$ok = $false
$health = $null
for ($i = 0; $i -lt 15 -and -not $ok; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4100/api/health' -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $ok = $true; $health = $r.Content | ConvertFrom-Json }
  } catch { }
}

if ($ok) {
  Write-Host "`nDone. App is answering on 127.0.0.1:4100." -ForegroundColor Green
  # The route answers 200 even when the database is unreachable, on purpose -
  # so the app can show a real error rather than hang. That makes this line the
  # difference between a working deploy and one that will fail at the sign-in
  # screen, and it is worth reading before you walk away.
  Write-Host "  database = $($health.database)" -ForegroundColor Green
  if ($health.database -ne 'up') {
    Write-Host "  WARNING: the app cannot reach the database. Check app\.env." -ForegroundColor Red
  }
} else {
  Write-Host "`nDeployed, but the app is NOT answering on 127.0.0.1:4100." -ForegroundColor Red
  Write-Host "Look at the log:  $appLive\logs\error.log" -ForegroundColor Red
  Write-Host "Or:  `$env:PM2_HOME='$env:PM2_HOME'; & '$pm2Cmd' logs odyssey-ai" -ForegroundColor Red
}
