# ============================================================
#  deploy-local.ps1  -  RUN THIS ON YOUR PC (not the server)
# ------------------------------------------------------------
#  Builds OdysseyAI for the web and stages everything the
#  server needs into  deploy\staged\ .
#
#  After it finishes, copy the  deploy\staged  folder to the VM
#  (drag it across your RDP-mapped drive) and double-click
#  update.bat on the VM.
#
#  Usage:  right-click -> "Run with PowerShell"
#          or:  powershell -ExecutionPolicy Bypass -File deploy-local.ps1
#          add  -WithSourceMaps  to ship .map files (see below)
# ============================================================
param(
  # Server source maps are ~124MB against ~90MB for everything else, and they
  # buy exactly one thing: stack traces in app\logs\error.log that name a line
  # in src\ instead of a column in a bundled chunk. Worth it while a fault is
  # being chased, not worth dragging across RDP every routine deploy.
  [switch]$WithSourceMaps
)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's folder
$root   = Split-Path -Parent $PSScriptRoot
$staged = Join-Path $PSScriptRoot 'staged'
$app    = Join-Path $staged 'app'

# ---- Tree copies go through robocopy -----------------------
# Copy-Item -Recurse cannot express "everything except these subtrees", and its
# -Exclude only applies to the top level. Next's output is also full of
# [bracketed] filenames, which are wildcard syntax to Copy-Item's -Path.
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

Write-Host "`n=== OdysseyAI deploy: building locally ===`n" -ForegroundColor Cyan

# --- 1. Build the WEB app -----------------------------------
# Deliberately `npm run build`, NOT `build:desktop`. APP_MODE is what decides
# whether NEXT_PUBLIC_APP_MODE is baked in as 'desktop' or 'web', and it is
# baked at BUILD time - a desktop bundle deployed to a server renders the
# Electron-only paths and cannot be fixed with an env var afterwards. Clearing
# the variables here means a leftover `dev:desktop` shell cannot poison it.
Write-Host "[1/6] Building Next app (web)..." -ForegroundColor Yellow
$env:APP_MODE = $null
$env:NEXT_PUBLIC_APP_MODE = $null
Push-Location $root
# Deliberately NOT an unconditional `npm install`. On this machine electron's
# postinstall does not survive a reinstall - node_modules\electron\dist comes
# back holding only locales\, and the desktop dev setup has to be repaired by
# hand from the cached zip. Publishing the WEB app must not cost that. So the
# install runs only when there is nothing to build against at all.
if (-not (Test-Path (Join-Path $root 'node_modules\next'))) {
  Write-Host "      node_modules is missing - installing..." -ForegroundColor DarkGray
  npm install
}
npm run build
Pop-Location

$nextDir    = Join-Path $root '.next'
$standalone = Join-Path $nextDir 'standalone'
$serverJs   = Join-Path $standalone 'server.js'
if (-not (Test-Path $serverJs)) {
  throw "No .next\standalone\server.js after the build. Is output:'standalone' still set in next.config.mjs?"
}

# Prove it is a web build before anything is staged.
#
# next build serialises the resolved config into server.js, so the mode it was
# built with is readable here - which is the only place it CAN be checked. The
# server cannot tell the difference: /api/health reports APP_MODE, a runtime
# variable that is unset on a server either way, while what actually decides
# how the app behaves is NEXT_PUBLIC_APP_MODE baked into the client bundle. A
# desktop build would deploy cleanly, answer healthy, and render the
# Electron-only paths to every customer.
if ((Get-Content $serverJs -TotalCount 40) -match '"NEXT_PUBLIC_APP_MODE":"desktop"') {
  throw "The build in .next\standalone is a DESKTOP build. Close any shell left over from npm run dev:desktop and run this script again."
}

# --- 2. Stage the app ---------------------------------------
#
# ── WHY THIS IS NOT JUST A COPY OF .next\standalone ───────────────────────
#
# Because that does not run. This app builds with Turbopack, and a standalone
# build does NOT trace Turbopack's server chunks: .next\standalone\.next\server
# came out with 3 files under chunks\ where the real build has 1,095. The app
# then starts, serves /api/health... and 500s on it, and on every page, with
#
#     Cannot find module '.next\server\chunks\[root-of-the-server]__*.js'
#
# electron-builder.yml hit exactly this and says so at length; the same split
# is applied here for the same reason. The REAL .next is shipped, and
# standalone is used only for the one thing it gets right - the traced module
# list, which is derived from those same chunks and is complete for them:
#
#     whole node_modules   33,969 files  468MB
#     traced               ~1,340 files   22MB
#
# If a later Next fixes Turbopack tracing this collapses back to one copy of
# standalone - but verify that by SERVING A PAGE, not by comparing folders.
Write-Host "`n[2/6] Staging the app into deploy\staged\app ..." -ForegroundColor Yellow
if (Test-Path $staged) { Remove-Item $staged -Recurse -Force }
New-Item -ItemType Directory -Path $app -Force | Out-Null

# The build output, less the parts nothing runs. `next dev` and `next build`
# write into the SAME .next, and on a machine that has run the desktop dev
# server .next\dev reaches 7GB and .next\cache another 700MB.
$exclude = @(
  '/XD', (Join-Path $nextDir 'dev'), (Join-Path $nextDir 'cache'), (Join-Path $nextDir 'standalone')
)
if (-not $WithSourceMaps) {
  $exclude += @('/XF', '*.map')
  Write-Host "      (source maps excluded - pass -WithSourceMaps to keep them)" -ForegroundColor DarkGray
}
Invoke-Robocopy $nextDir (Join-Path $app '.next') $exclude

# The traced dependency set, and only that.
Invoke-Robocopy (Join-Path $standalone 'node_modules') (Join-Path $app 'node_modules')

# ── THE SAME TURBOPACK GAP, ONE LEVEL DOWN ────────────────────────────────
#
# The trace misses Next's own server runtimes as well: the staged
# next\dist\compiled\next-server came out with 3 of the 13 .runtime.prod.js
# files, and the app then starts, prints "Ready", reports online under PM2 -
# and answers nothing, logging
#
#     Cannot find module 'next/dist/compiled/next-server/app-route-turbo.runtime.prod.js'
#
# on every request. Nothing on disk looks wrong; the file is simply not there.
#
# 4.1MB for all thirteen, so they are shipped wholesale rather than picked
# over. .map and the .runtime.dev.js set (13MB, dev only) are left behind.
Invoke-Robocopy (Join-Path $root 'node_modules\next\dist\compiled\next-server') `
                (Join-Path $app  'node_modules\next\dist\compiled\next-server') `
                @('/XF', '*.map', '*.runtime.dev.js')

# public\ is served by the Next process, not by IIS - .next\static too, and it
# came across inside .next above.
Invoke-Robocopy (Join-Path $root 'public') (Join-Path $app 'public')

# server.js is the standalone entry point and is correct as generated; it was
# only ever the .next beside it that was incomplete.
Copy-Item $serverJs                            $app
Copy-Item (Join-Path $root 'next.config.mjs')  $app
Copy-Item (Join-Path $root 'package.json')     $app
# The template the server's own .env is written from. The real .env is never
# staged: it holds this machine's credentials, and - worse - it would OVERRIDE
# the server's own at startup, so the live site would quietly read and write
# the dev database.
Copy-Item (Join-Path $root '.env.example')     $app

# --- 3. Migration tooling -----------------------------------
# Migrations are applied BY HAND and usually have to run ON THE SERVER, because
# the database grants are IP-whitelisted to it. The runners resolve sql/ as
# ../sql from their own folder, so this layout has to mirror the repo's.
Write-Host "`n[3/6] Staging migrations and their runners..." -ForegroundColor Yellow
Invoke-Robocopy (Join-Path $root 'sql') (Join-Path $app 'sql')
New-Item -ItemType Directory -Path (Join-Path $app 'scripts')  -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $app 'electron') -Force | Out-Null
Copy-Item (Join-Path $root 'scripts\tickets-migrate.mjs') (Join-Path $app 'scripts')
Copy-Item (Join-Path $root 'scripts\site-migrate.mjs')    (Join-Path $app 'scripts')
Copy-Item (Join-Path $root 'scripts\box-migrate.mjs')     (Join-Path $app 'scripts') -ErrorAction SilentlyContinue
# Diagnostics. Answers "does the SITE connection see this table" - which the
# migration ledger cannot (see sql/site/098_restore_products.sql) and a
# control-credentials check does not ask.
Copy-Item (Join-Path $root 'scripts\probe-site-table.mjs') (Join-Path $app 'scripts') -ErrorAction SilentlyContinue
# The applying half. site-migrate.mjs imports it, and it reads sql/<kind>/ as a
# sibling of its own parent - which is why it goes in app\electron\.
Copy-Item (Join-Path $root 'electron\siteMigrate.js')     (Join-Path $app 'electron')

# --- 4. Bundle PM2 (its own copy, its own daemon) -----------
# PM2 is not a dependency of the app, so it gets its own tiny package here on
# your PC - which has internet - and ships inside 'staged'. The server never
# runs npm.
#
# A SEPARATE folder, not app\node_modules, for a reason that matters on this
# VM: Odyssey_bind's deploy runs `pm2 kill`, and PM2 has one daemon per
# PM2_HOME regardless of where the binary lives. update-on-server.ps1 gives
# OdysseyAI its own PM2_HOME so the two apps can never stop each other.
Write-Host "`n[4/6] Bundling PM2..." -ForegroundColor Yellow
$pm2Dir = Join-Path $staged 'pm2'
New-Item -ItemType Directory -Path $pm2Dir | Out-Null
@'
{
  "name": "odyssey-ai-pm2",
  "private": true,
  "description": "Process manager shipped with the OdysseyAI deploy so the server needs no npm.",
  "dependencies": { "pm2": "^5.4.3" }
}
'@ | Set-Content (Join-Path $pm2Dir 'package.json') -Encoding utf8
Push-Location $pm2Dir
npm install --omit=dev
Pop-Location

# --- 5. Server-side pieces ----------------------------------
Write-Host "`n[5/6] Staging the server-side scripts..." -ForegroundColor Yellow

# PM2 needs this beside server.js. It carries PORT and HOSTNAME, which is not
# optional: server.js reads process.env.PORT on its FIRST executable line,
# before Next has loaded .env at all, so a PORT set in .env is read too late
# and the app would answer on 3000 instead.
Copy-Item (Join-Path $PSScriptRoot 'ecosystem.config.js') $app

# The IIS site's physical path. It holds nothing but the rewrite rule - every
# byte the browser gets is served by the Next process behind it.
$siteDir = Join-Path $staged 'site'
New-Item -ItemType Directory -Path $siteDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'web.config') $siteDir

Copy-Item (Join-Path $PSScriptRoot 'update.bat')           $staged
Copy-Item (Join-Path $PSScriptRoot 'update-on-server.ps1') $staged
Copy-Item (Join-Path $PSScriptRoot 'iis-setup.ps1')        $staged
Copy-Item (Join-Path $PSScriptRoot 'README-SERVER.md')     $staged

# --- 6. Prove it runs before it leaves this machine ---------
#
# The failure this catches is the one above: an app that starts, passes every
# folder-shaped check, and then 500s on the first request. A size comparison
# would not have caught it. Serving a page does.
#
# ── AND IT HAS TO RUN OUTSIDE THE REPOSITORY ──────────────────────────────
#
# Tested in place, this proves nothing. Node resolves a missing module by
# walking UP the directory tree, so an app under deploy\staged\app finds
# OdysseyAI\node_modules two levels above it and runs perfectly on modules that
# were never staged. That is exactly how the missing next-server runtimes above
# got through a passing smoke test and only failed on a machine that had no
# repository to fall back on.
#
# So the test runs from a copy in TEMP, where the nearest node_modules is the
# staged one. Costs a ~10 second copy per deploy; it is the only check here
# that can see this whole class of fault.
Write-Host "`n[6/6] Smoke-testing the staged build on port 4198..." -ForegroundColor Yellow
$probe = Join-Path $env:TEMP 'odyssey_ai-smoke'
if (Test-Path $probe) { Remove-Item $probe -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "      (copying to $probe - outside the repo, so nothing can be resolved from it)" -ForegroundColor DarkGray
Invoke-Robocopy $app $probe
$log  = Join-Path $env:TEMP 'odyssey_ai-stage-smoke.log'
# Set on this process so the child inherits it. Start-Process -Environment is
# PowerShell 7.4+, and this script has to run under the Windows PowerShell 5.1
# that `powershell -ExecutionPolicy Bypass` gives you.
$savedPort = $env:PORT
$env:PORT     = '4198'
$env:HOSTNAME = '127.0.0.1'
$env:NODE_ENV = 'production'
$proc = Start-Process node -ArgumentList 'server.js' -WorkingDirectory $probe -PassThru -NoNewWindow `
          -RedirectStandardOutput $log -RedirectStandardError "$log.err"
try {
  # Both halves, because they load through different Next runtimes and have
  # failed independently: /api/health is an App Route, / is a Server Component.
  # A build missing app-route-turbo.runtime.prod.js serves neither, but a build
  # missing only one of the two would look fine if only one were asked for.
  $checks = @{ '/api/health' = $false; '/' = $false }
  for ($i = 0; $i -lt 20 -and ($checks.Values -contains $false); $i++) {
    Start-Sleep -Seconds 2
    foreach ($u in @($checks.Keys)) {
      if ($checks[$u]) { continue }
      try {
        $r = Invoke-WebRequest ('http://127.0.0.1:4198' + $u) -UseBasicParsing -TimeoutSec 10
        if ($r.StatusCode -eq 200) { $checks[$u] = $true }
      } catch { }
    }
  }
  if ($checks.Values -contains $false) {
    $failed = ($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key }) -join ', '
    Write-Host "`n  The staged build does not serve: $failed" -ForegroundColor Red
    Write-Host "  First lines of its stderr:" -ForegroundColor Red
    Get-Content "$log.err" -TotalCount 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    throw "Staged build failed its smoke test - do not deploy it."
  }
  Write-Host "      /api/health and / both answered 200, with no repo to borrow from." -ForegroundColor DarkGray
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  $env:PORT = $savedPort
  Start-Sleep -Seconds 1
  Remove-Item $probe -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Done ---------------------------------------------------
$size = '{0:N0} MB' -f ((Get-ChildItem $staged -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "`nDone. Staged $size at:" -ForegroundColor Green
Write-Host "      $staged" -ForegroundColor Green
Write-Host @"

NEXT STEPS:
  1. Open your RDP session to the server.
  2. Copy the whole 'staged' folder to the server.
  3. FIRST TIME ONLY: run iis-setup.ps1 as Administrator, then create
     C:\inetpub\odyssey_ai\app\.env from the staged app\.env.example.
  4. On the SERVER, double-click  update.bat  inside that folder.

NOTE: .env is intentionally NOT copied. The server keeps its own
      app\.env with the real DB credentials, and its own app\uploads.
"@ -ForegroundColor Cyan
