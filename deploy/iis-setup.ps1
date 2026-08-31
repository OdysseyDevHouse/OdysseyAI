# ============================================================
#  iis-setup.ps1  -  RUN ONCE ON THE SERVER, AS ADMINISTRATOR
# ------------------------------------------------------------
#  Creates the IIS site that fronts OdysseyAI, turns on the ARR
#  proxy settings the app depends on, and registers the boot
#  task that brings the app back after a reboot.
#
#  Safe to re-run: every step checks before it changes anything.
#
#  Usage (elevated PowerShell, from inside the staged folder):
#    powershell -ExecutionPolicy Bypass -File .\iis-setup.ps1
#    powershell -ExecutionPolicy Bypass -File .\iis-setup.ps1 -HostHeader app.example.co.za
# ============================================================
param(
  [string]$SiteName   = 'odyssey_ai',
  [string]$Target     = 'C:\inetpub\odyssey_ai',
  [int]   $Port       = 80,

  # The hostname this site answers on. Effectively REQUIRED on this VM, which
  # already serves Odyssey_Bind and Odyssey_Portal: without it the binding is
  # `*:80:` — every IP, no hostname — which catches ALL plain-HTTP traffic to
  # the machine and collides with any other site bound the same way. IIS will
  # not start two sites with identical bindings, so the casualty is whichever
  # one loses the race.
  [string]$HostHeader = '',

  # Deliberate escape hatch for a machine that really does serve one site.
  # Named so it cannot be typed by accident.
  [switch]$AllowCatchAllBinding,

  # ARR's preserveHostHeader lives in applicationHost.config and is therefore
  # SERVER-WIDE: turning it on changes how every proxied site on this box sees
  # its requests, Odyssey_Bind's /api -> :3001 included. So it is opt-in. The
  # script reports the current value either way, and names the per-app
  # alternative if it is off. See the note at step 2.
  [switch]$SetPreserveHostHeader,

  [int]   $AppPort    = 4100
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this in an ELEVATED PowerShell (right-click -> Run as Administrator)."
}

$appcmd = Join-Path $env:windir 'System32\inetsrv\appcmd.exe'
if (-not (Test-Path $appcmd)) { throw "IIS is not installed on this machine ($appcmd not found)." }

Import-Module WebAdministration

Write-Host "`n=== OdysseyAI: one-time IIS setup ===`n" -ForegroundColor Cyan

# --- 1. The two IIS modules this depends on -----------------
Write-Host "[1/5] Checking IIS modules..." -ForegroundColor Yellow
$missing = @()
if (-not (Test-Path (Join-Path $env:windir 'System32\inetsrv\rewrite.dll'))) {
  $missing += 'URL Rewrite 2.1    https://www.iis.net/downloads/microsoft/url-rewrite'
}
if (-not (Test-Path (Join-Path $env:ProgramFiles 'IIS\Application Request Routing'))) {
  $missing += 'ARR 3.0            https://www.iis.net/downloads/microsoft/application-request-routing'
}
if ($missing.Count) {
  Write-Host "  MISSING - install these, then re-run this script:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  throw "Required IIS modules are not installed."
}
Write-Host "  URL Rewrite and ARR are present." -ForegroundColor DarkGray

# --- 2. ARR proxy settings ----------------------------------
# These live in applicationHost.config, not in the site's web.config, which is
# why they cannot ship with the staged folder.
#
# `enabled` is safe to set: this VM already needs it for Odyssey_Bind's
# /api -> :3001 rule, so setting it True is a no-op here.
#
# preserveHostHeader is the one that is easy to miss and expensive to debug.
# With it off, ARR rewrites the request as `Host: 127.0.0.1:4100` while the
# browser still sends `Origin: https://your.public.host`. Next compares those
# two on every Server Action and rejects the mismatch — so the site RENDERS
# perfectly and then every save, every form, every delete fails with an opaque
# "Invalid Server Actions request". Nothing in the app's own logs points at IIS.
#
# But it is SERVER-WIDE, and this box runs a live site. Flipping it changes
# what Odyssey_Bind's Express backend sees in Host on every proxied request.
# So it is not set unless asked for, and there is a per-app alternative that
# touches nothing outside this project:
#
#     experimental: { serverActions: { allowedOrigins: ['your.public.host'] } }
#
# in next.config.mjs. That is read at BUILD time and baked into the output, so
# it needs a re-run of deploy-local.ps1 rather than a server-side edit.
Write-Host "`n[2/5] ARR proxy settings..." -ForegroundColor Yellow
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /commit:apphost | Out-Null
Write-Host "  proxy enabled (no-op if it already was)" -ForegroundColor DarkGray

$phh = (& $appcmd list config -section:system.webServer/proxy) -join ' '
$phhOn = $phh -match 'preserveHostHeader="true"'
if ($SetPreserveHostHeader) {
  & $appcmd set config -section:system.webServer/proxy /preserveHostHeader:"True" /commit:apphost | Out-Null
  Write-Host "  preserveHostHeader = True (SERVER-WIDE - affects every proxied site)" -ForegroundColor Yellow
} elseif ($phhOn) {
  Write-Host "  preserveHostHeader is already True - nothing to change" -ForegroundColor DarkGray
} else {
  Write-Host "  preserveHostHeader is False and was LEFT ALONE (it is server-wide)." -ForegroundColor Yellow
  Write-Host "  Server Actions will fail until you do ONE of:" -ForegroundColor Yellow
  Write-Host "    - add serverActions.allowedOrigins to next.config.mjs and re-stage  (per-app, safe here)" -ForegroundColor Yellow
  Write-Host "    - re-run this script with -SetPreserveHostHeader                    (global, affects Odyssey_Bind)" -ForegroundColor Yellow
}

# --- 3. The site --------------------------------------------
Write-Host "`n[3/5] Creating the IIS site '$SiteName'..." -ForegroundColor Yellow
$siteDir = Join-Path $Target 'site'
New-Item -ItemType Directory -Path $siteDir -Force | Out-Null

if (-not (Test-Path "IIS:\AppPools\$SiteName")) {
  New-WebAppPool -Name $SiteName | Out-Null
}
# No .NET is ever executed here — the site is a rewrite rule and nothing else.
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ''

$binding = if ($HostHeader) { "*:${Port}:$HostHeader" } else { "*:${Port}:" }

# Never quietly take a binding another site is already serving on. IIS does not
# reject the duplicate at creation time — it accepts it and then refuses to
# START one of the two, and which one loses is not something to find out on a
# machine with a live site on it.
$clash = Get-Website | Where-Object { $_.Name -ne $SiteName } |
  Where-Object { $_.Bindings.Collection.bindingInformation -contains $binding }
if ($clash) {
  throw "Binding '$binding' is already used by IIS site '$($clash.Name -join ', ')'. Give this site its own hostname with -HostHeader, or a free port with -Port."
}
if (-not $HostHeader -and -not $AllowCatchAllBinding) {
  Write-Host "`n  Refusing to create the catch-all binding '$binding'." -ForegroundColor Red
  Write-Host "  On a machine that already serves Odyssey_Bind and Odyssey_Portal, a binding" -ForegroundColor Red
  Write-Host "  with no hostname takes every plain-HTTP request to the box." -ForegroundColor Red
  Write-Host "  Existing sites and their bindings:" -ForegroundColor Red
  Get-Website | ForEach-Object {
    Write-Host ("    {0,-24} {1}" -f $_.Name, (($_.Bindings.Collection.bindingInformation) -join '  ')) -ForegroundColor Red
  }
  throw "Re-run with -HostHeader <your.domain>, or -AllowCatchAllBinding if you are certain."
}

if (Test-Path "IIS:\Sites\$SiteName") {
  Write-Host "  Site already exists - updating its physical path only." -ForegroundColor DarkGray
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $siteDir
} else {
  New-Website -Name $SiteName -PhysicalPath $siteDir -ApplicationPool $SiteName `
              -Port $Port -HostHeader $HostHeader -Force | Out-Null
  Write-Host "  Created, bound to $binding" -ForegroundColor DarkGray
}

# --- 4. Bring the app back after a reboot -------------------
# PM2's own `pm2 startup` does not support Windows. A scheduled task calling
# `pm2 resurrect` is the equivalent: `pm2 save` (which update-on-server.ps1
# runs on every deploy) writes the process list, and this replays it.
#
# PM2_HOME is set explicitly because this runs as SYSTEM, whose profile is not
# the one the deploy script used — without it, resurrect would look in an empty
# home, find no saved list, and start nothing at all.
Write-Host "`n[4/5] Registering the boot task..." -ForegroundColor Yellow
$resurrect = Join-Path $Target 'pm2-resurrect.cmd'
@"
@echo off
set PM2_HOME=$Target\.pm2
call "$Target\pm2\node_modules\.bin\pm2.cmd" resurrect
"@ | Set-Content $resurrect -Encoding ascii

$taskName = 'OdysseyAI'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName `
  -Action    (New-ScheduledTaskAction -Execute $resurrect) `
  -Trigger   (New-ScheduledTaskTrigger -AtStartup) `
  -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest) `
  -Settings  (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries) `
  -Description 'Restarts the OdysseyAI web app after a reboot (pm2 resurrect).' | Out-Null
Write-Host "  Scheduled task '$taskName' registered (at startup, as SYSTEM)." -ForegroundColor DarkGray

# --- 5. What is left for you --------------------------------
Write-Host "`n[5/5] Done." -ForegroundColor Green
Write-Host @"

STILL TO DO, BY HAND:

  1. Create  $Target\app\.env
     Copy it from  $Target\app\.env.example  and fill in at least:
       DB_HOST / DB_USER / DB_PASSWORD / DB_NAME
       SESSION_SECRET      (node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
       ENCRYPTION_KEY      (MUST be byte-identical to the v2 backend's)
       APP_URL             the real public address - links in emails are built from it

  2. Run  update.bat  in the staged folder to deploy and start the app.

  3. If this site is public, add an HTTPS binding and a certificate in IIS
     Manager, then set APP_URL to the https:// address.

  Port $AppPort is loopback-only by design; the site answers on $binding.
"@ -ForegroundColor Cyan
