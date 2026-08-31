<#
    Times an Odyssey install on the machine it is actually slow on.

    -- WHY THIS EXISTS --------------------------------------------------------

    The packaging work was measured on a developer's NVMe with Defender off,
    where writing the app payload took 25 seconds. On a shop's all-in-one the
    same install takes half an hour, and the whole gap is per-file cost that a
    development machine cannot reproduce. Guessing at the ratio is how you spend
    a week optimising the wrong half.

    So this measures the two halves separately, on the real hardware:

      1. NSIS extraction   -  the installer process, timed, with the install
         directory sampled once a second so the curve shows where it stalls.
      2. The provisioning wizard  -  read afterwards from Odyssey's own log,
         which now timestamps each phase (electron/dbSetupBridge.js).

    -- RUN IT ON A SPARE MACHINE ----------------------------------------------

    It installs software and can uninstall first. Do not point it at a shop that
    is trading. If the only machine available IS a live one, run it after close
    and take a backup of ProgramData\Odyssey first  -  the uninstaller does not
    touch the database, but this script is not the thing to find that out with.

        powershell -ExecutionPolicy Bypass -File measure-install.ps1 `
                   -Installer "C:\Users\You\Desktop\Odyssey Back Office-0.1.0-x64.exe"

    Add -Uninstall to remove an existing copy first, which is what makes a
    before/after comparison honest  -  installing over the top does far less work
    than a first install and will flatter whichever version runs second.
#>
[CmdletBinding()]
param(
    # The .exe to time. Use the same path style for both runs when comparing.
    [Parameter(Mandatory = $true)]
    [string] $Installer,

    # Where the app lands. Only used for sampling; NSIS decides for itself.
    [string] $InstallDir = "$env:ProgramFiles\OdysseyAI Back Office",

    # Remove an existing install first. Off by default: destructive.
    [switch] $Uninstall,

    # Where to write the report.
    [string] $OutFile = "$env:USERPROFILE\Desktop\odyssey-install-timing.txt"
)

$ErrorActionPreference = 'Stop'
$report = [System.Collections.Generic.List[string]]::new()
function Say([string] $line) {
    Write-Host $line
    $report.Add($line)
}

Say "Odyssey install timing  -  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say ("=" * 64)

# -- THE MACHINE ------------------------------------------------------------
# Recorded because the numbers below mean nothing without it. The single most
# important line is the media type: eMMC and a spinning disk behave nothing like
# the SSD every developer has, and that difference IS the support ticket.
Say ''
Say '-- Machine --'
try {
    $cs  = Get-CimInstance Win32_ComputerSystem
    $os  = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    Say ("Model        : {0} {1}" -f $cs.Manufacturer, $cs.Model)
    Say ("CPU          : {0} ({1} cores)" -f $cpu.Name.Trim(), $cpu.NumberOfCores)
    Say ("RAM          : {0:N1} GB" -f ($cs.TotalPhysicalMemory / 1GB))
    Say ("OS           : {0} {1}" -f $os.Caption, $os.Version)
} catch { Say "Machine info unavailable: $($_.Exception.Message)" }

try {
    $sysDrive = ($env:SystemDrive).TrimEnd(':')
    Get-PhysicalDisk | ForEach-Object {
        Say ("Disk         : {0}  -  {1}, {2:N0} GB, bus {3}" -f `
             $_.FriendlyName, $_.MediaType, ($_.Size / 1GB), $_.BusType)
    }
    $free = (Get-PSDrive $sysDrive).Free / 1GB
    Say ("Free space   : {0:N1} GB on {1}:" -f $free, $sysDrive)
} catch { Say "Disk info unavailable: $($_.Exception.Message)" }

# -- DEFENDER ------------------------------------------------------------
# The prime suspect. Real-time protection scans every file as it is written, and
# an install is tens of thousands of small files. If this says True and the
# install is slow, that is the finding  -  not a guess.
Say ''
Say '-- Windows Defender --'
try {
    $mp = Get-MpComputerStatus
    Say ("Real-time protection : {0}" -f $mp.RealTimeProtectionEnabled)
    Say ("On-access protection : {0}" -f $mp.OnAccessProtectionEnabled)
    $ex = @((Get-MpPreference).ExclusionPath)
    Say ("Exclusion paths      : {0}" -f $(if ($ex.Count) { $ex -join '; ' } else { 'none' }))
} catch {
    Say "Defender status unavailable (third-party AV, or policy): $($_.Exception.Message)"
    Say "If a third-party antivirus is installed, NAME IT in the report  -  it matters as much as Defender."
}

if (-not (Test-Path $Installer)) { throw "Installer not found: $Installer" }
Say ''
Say ("Installer    : {0}" -f (Split-Path $Installer -Leaf))
Say ("Size         : {0:N1} MB" -f ((Get-Item $Installer).Length / 1MB))

# -- OPTIONAL CLEAN SLATE ---------------------------------------------------
if ($Uninstall) {
    Say ''
    Say '-- Removing the existing install first --'
    # Named after the product, which differs per installer (Back Office / Point
    # of Sale / Database Setup). Found rather than assumed, so this script works
    # for all three without an edit.
    $un = Get-ChildItem -LiteralPath $InstallDir -Filter 'Uninstall *.exe' -ErrorAction SilentlyContinue |
          Select-Object -First 1 -ExpandProperty FullName
    if ($un -and (Test-Path $un)) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Start-Process -FilePath $un -ArgumentList '/S' -Wait
        # NSIS uninstallers detach a helper; wait for the directory to actually go.
        $deadline = (Get-Date).AddMinutes(5)
        while ((Test-Path $InstallDir) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
        $sw.Stop()
        Say ("Uninstall took {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    } else {
        Say 'Nothing installed at that path; carrying on.'
    }
}

# -- THE INSTALL ITSELF -----------------------------------------------------
# /S is NSIS's silent switch. Silent so the timing is the machine's work rather
# than how fast somebody clicks Next.
#
# /D= IS DELIBERATELY NOT PASSED, AND THAT COST AN EVENING TO WORK OUT.
#
# electron-builder's NSIS does support /D, but it re-reads it in multiUser.nsh
# with ${StdUtils.GetParameter}, which splits on WHITESPACE:
#
#     ${StdUtils.GetParameter} $R0 "D" ""
#     ${If} $R0 != ""
#       StrCpy $INSTDIR $R0
#
# So "/D=C:\Program Files\Odyssey Back Office" sets $INSTDIR to "C:\Program".
# The installer then runs happily, creates C:\Program, and finishes in seconds
# while the directory being sampled stays empty - which reads exactly like a
# fast install of nothing. Quoting does not help: classic NSIS requires /D
# unquoted, and a quoted value is discarded instead.
#
# So the installer is left to choose its own location and this script FINDS it,
# which is more honest anyway: where a silent install lands is a fact about the
# build, not something a measurement should be dictating.
Say ''
Say '-- Installing --'
Say ("Target       : {0}" -f $InstallDir)
Say '(If that is not where this machine really keeps Odyssey, stop and re-run'
Say ' with -InstallDir set to the right path, or the timings mean nothing.)'
if (Test-Path $InstallDir) {
    Say "NOTE: $InstallDir already exists. This is an UPGRADE, not a first install;"
    Say "      it does less work. Re-run with -Uninstall for a comparable number."
}

# Everywhere this build could put itself. Whichever grows is the real one.
$product = try { (Get-Item $Installer).VersionInfo.ProductName } catch { 'Odyssey' }
$candidates = @(
    $InstallDir
    (Join-Path "$env:LOCALAPPDATA\Programs" $product)
    (Join-Path "$env:ProgramFiles" $product)
    # Pre-rename installs, which are what an upgrade measurement starts from.
    (Join-Path "$env:ProgramFiles" ($product -replace '^OdysseyAI ', 'Odyssey '))
    (Join-Path "$env:LOCALAPPDATA\Programs" ($product -replace '^OdysseyAI ', 'Odyssey '))
    'C:\Program'
) | Select-Object -Unique

$samples = [System.Collections.Generic.List[string]]::new()
$sw = [Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru

# Sample once a second. The curve is the point: a long flat tail after the file
# count stops growing is post-processing, not extraction, and the two have
# completely different fixes.
# WAITING ON $proc ALONE IS NOT ENOUGH.
#
# Odyssey Database Setup sets requestedExecutionLevel:requireAdministrator, so
# NSIS relaunches itself and the process started here exits within seconds while
# the real install carries on in another one. The first run of this script
# against that build reported a cheerful "8.3s, 0 files" and looked like a
# result rather than a failure.
#
# So the loop ends only when BOTH are true: no process named after this
# installer is still running, AND the directory has stopped growing for a few
# consecutive samples. The second condition also catches post-processing that
# outlives the installer process.
$installerName = [IO.Path]::GetFileNameWithoutExtension($Installer)
$stableFor = 0
$lastCount = 0
while ($true) {
    $running = $false
    if (-not $proc.HasExited) { $running = $true }
    elseif (@(Get-Process -Name $installerName -ErrorAction SilentlyContinue).Count -gt 0) { $running = $true }

    if (-not $running) {
        # Five quiet samples in a row before believing it is finished.
        if ($stableFor -ge 5) { break }
    }
    Start-Sleep -Seconds 1
    # Summed across every place this build might plausibly land, so the curve is
    # right regardless of which one it chose. C:\Program is in the list on
    # purpose - it is where a /D with spaces used to strand an install, and a
    # silent zero is exactly the failure worth catching loudly.
    $n = 0; $mb = 0
    foreach ($cand in $candidates) {
        if (-not (Test-Path $cand)) { continue }
        try {
            $files = Get-ChildItem -LiteralPath $cand -Recurse -File -ErrorAction SilentlyContinue
            $n  += @($files).Count
            $mb += (($files | Measure-Object -Property Length -Sum).Sum) / 1MB
        } catch { }
    }
    if ($n -ne $lastCount) { $stableFor = 0 } else { $stableFor++ }
    if ($n -ne $lastCount -or ($sw.Elapsed.TotalSeconds % 10) -lt 1) {
        $line = "  {0,6:N0}s  {1,7:N0} files  {2,8:N0} MB" -f $sw.Elapsed.TotalSeconds, $n, $mb
        $samples.Add($line)
        $lastCount = $n
        # ── SHOWN LIVE, KEPT OUT OF THE REPORT ─────────────────────────────
        #
        # An install on this hardware takes ten minutes or more, and a console
        # that prints nothing for ten minutes is indistinguishable from one that
        # has hung - which is exactly the wrong thing for a script whose whole
        # job is to be left alone while it runs. It cost one false "it's stuck"
        # already.
        #
        # Write-Host rather than Say: the report keeps the thinned 40-line
        # version at the end, because a per-second curve is unreadable in a file
        # somebody has to scroll through.
        Write-Host ("`r" + $line + "   ") -NoNewline
    }
}
$sw.Stop()
Write-Host ''

Say ("INSTALLER WALL CLOCK : {0:N1}s  ({1:N1} min)" -f $sw.Elapsed.TotalSeconds, $sw.Elapsed.TotalMinutes)
$installedCount = 0
foreach ($cand in $candidates) {
    if (-not (Test-Path $cand)) { continue }
    $files = Get-ChildItem -LiteralPath $cand -Recurse -File -ErrorAction SilentlyContinue
    $c = @($files).Count
    if ($c -eq 0) { continue }
    $installedCount += $c
    Say ("Installed to         : {0}" -f $cand)
    Say ("                       {0:N0} files, {1:N0} MB" -f $c,
         ((($files | Measure-Object -Property Length -Sum).Sum) / 1MB))
}

# A number nobody should have to interpret. Zero files is not a fast install, it
# is a failed one, and saying so here saves somebody reporting it as a result.
if ($installedCount -eq 0) {
    Say ''
    Say '*** THIS RUN MEASURED NOTHING ***'
    Say 'The installer finished but the target directory is empty. Usual causes:'
    Say '  - wrong installer for this -InstallDir (check the Product line below)'
    Say '  - the install went somewhere else; re-run with the right -InstallDir'
    Say '  - the installer was cancelled, or refused elevation'
    try {
        Say ("Installer product    : {0}" -f (Get-Item $Installer).VersionInfo.ProductName)
    } catch { }
    Say 'Do not send this report as a timing; fix the cause and run it again.'
}

Say ''
Say '-- Extraction curve (only the samples where the count changed) --'
# Thinned to 40 lines: enough to see the shape, short enough to paste.
$step = [Math]::Max(1, [int]([Math]::Ceiling($samples.Count / 40)))
for ($i = 0; $i -lt $samples.Count; $i += $step) { Say $samples[$i] }
if ($samples.Count) { Say $samples[$samples.Count - 1] }

# -- THE WIZARD'S OWN ACCOUNT -----------------------------------------------
# Odyssey timestamps each provisioning phase into its log. Nothing here starts
# the wizard  -  that needs a technician signing in  -  but once it has been run,
# re-running this script surfaces the timings without anybody transcribing them.
Say ''
Say '-- Provisioning phases, from Odyssey''s own log --'
$logs = @(
    "$env:APPDATA\odyssey-ai\odyssey.log",
    # Both namings: builds before the OdysseyAI rename are still in the field,
    # and a machine being measured may hold either.
    "$env:APPDATA\Odyssey Back Office\odyssey.log",
    "$env:APPDATA\Odyssey Database Setup\odyssey.log",
    "$env:APPDATA\OdysseyAI Back Office\odyssey.log",
    "$env:APPDATA\OdysseyAI Database Setup\odyssey.log"
) | Where-Object { Test-Path $_ }

if (-not $logs) {
    Say 'No Odyssey log found yet. Run the app (or Database Setup) once, then re-run this script.'
} else {
    foreach ($log in $logs) {
        Say ("From {0}:" -f $log)
        $lines = Get-Content $log -Tail 4000 |
                 Select-String -Pattern '\[setup\]|\[schema\]|\[mariadb\]|migrations applied' |
                 Select-Object -Last 40
        if ($lines) { $lines | ForEach-Object { Say ("  " + $_.Line) } }
        else { Say '  (no provisioning lines  -  this machine may not host the database)' }
    }
    Say ''
    Say 'Each line carries an ISO timestamp; subtract the first from the last for the'
    Say 'wizard total, and read the gaps between them for which phase actually cost.'
}

Say ''
Say ("=" * 64)
$report | Set-Content -Path $OutFile -Encoding utf8
Write-Host ''
Write-Host "Report written to $OutFile" -ForegroundColor Green
Write-Host 'Send that file back  -  it is the whole picture in one attachment.'
