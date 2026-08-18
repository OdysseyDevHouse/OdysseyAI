/**
 * Delete the temp Chrome profiles the verify/probe/smoke scripts leave behind.
 *
 *   node scripts/clean-chrome-profiles.mjs          # delete what is not in use
 *   node scripts/clean-chrome-profiles.mjs --dry    # just report
 *
 * ── WHY THIS IS NEEDED ───────────────────────────────────────────────────
 *
 * Every CDP script mints a fresh `--user-data-dir` under %TEMP%. Teardown
 * removes it, but a run that is Ctrl-C'd, killed, or crashes hard leaves the
 * directory behind — and a Chrome profile is not small. In practice these had
 * accumulated to 833 directories and ~57GB.
 *
 * The profile CANNOT simply be deleted from `process.on('exit')`: doing that
 * while the browser socket is still open crashes Node on Windows with
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 * and the run exits 9 — a passing suite reporting failure. So the exit path is
 * deliberately kill-only, and reclaiming the disk is this script's job.
 *
 * A directory still held by a running Chrome is skipped, so this is safe to
 * run at any time, including while a verification script is going.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DRY = process.argv.includes('--dry')
const TMP = tmpdir()

/** Profile directories currently passed to a running chrome.exe. */
function inUse() {
  const held = new Set()
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine }",
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    )
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/--user-data-dir="?([^"\s]+)/)
      if (m) held.add(path.resolve(m[1].replace(/[\\/]+$/, '')).toLowerCase())
    }
  } catch {
    // Cannot read the process table — treat everything as in use rather than
    // deleting a profile out from under a live browser.
    return null
  }
  return held
}

function bytes(dir) {
  let total = 0
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else {
        try { total += statSync(full).size } catch {}
      }
    }
  }
  walk(dir)
  return total
}

const held = inUse()
if (held === null) {
  console.error('Could not list running Chrome processes — refusing to delete anything.')
  process.exit(1)
}

const candidates = readdirSync(TMP, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^(odyssey-|ody-)/.test(e.name))
  .map((e) => path.join(TMP, e.name))

let deleted = 0
let skipped = 0
let failed = 0
let reclaimed = 0

for (const dir of candidates) {
  if (held.has(path.resolve(dir).toLowerCase())) {
    skipped++
    continue
  }
  const size = bytes(dir)
  if (DRY) {
    deleted++
    reclaimed += size
    continue
  }
  try {
    rmSync(dir, { recursive: true, force: true })
    deleted++
    reclaimed += size
  } catch {
    failed++
  }
}

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)}GB`
console.log(
  `${DRY ? '[dry] would delete' : 'deleted'} ${deleted} profile(s), ${gb(reclaimed)}` +
    `${skipped ? ` — skipped ${skipped} still in use` : ''}` +
    `${failed ? ` — ${failed} could not be removed` : ''}`,
)
