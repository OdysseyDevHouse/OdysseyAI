// Which release this machine follows: the shipping one, or a test build.
//
// ── WHY A MACHINE NEEDS TO BE TOLD ──────────────────────────────────────────
//
// electron-updater asks the bucket for `<channel>.yml`, and `latest` is simply
// the default channel name. Publishing `beta.yml` beside `latest.yml` therefore
// gives two live releases in one folder — but every installation asked for the
// same file, so a new build could go to nobody or to every shop on the
// platform. There was no way to put one in front of six machines first.
//
// This module is the third option. The control panel holds a channel per
// device (Control Panel v2 → Releases); this fetches it, remembers it, and
// hands it to updater.js before each check.
//
// ── IT MUST NEVER BE THE REASON AN UPDATE DOES NOT HAPPEN ───────────────────
//
// Every failure here answers 'stable': no answer from the server, a timeout, a
// machine that has never been online, a cache file somebody deleted. That is
// the shipping release — the thing the machine should be running — so the worst
// case is a beta tester who is briefly not testing, which somebody will notice
// and nobody will be hurt by. The reverse default would put unreleased software
// on a counter because a fetch failed, and that is not recoverable by noticing.
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

/** What every unknown resolves to. Kept identical to the column default in the
 *  control panel's migration 122 — the same decision, written in two places,
 *  and neither is safe to change alone. */
const DEFAULT_CHANNEL = 'stable'

/**
 * What electron-updater should be told, given what the control panel said.
 *
 * 'stable' maps to NULL rather than to the string 'latest', because setting
 * `autoUpdater.channel` at all has a side effect: it flips `allowDowngrade` to
 * true (see AppUpdater.js in electron-updater). Leaving it unset on the
 * ordinary path means the ordinary path keeps electron-updater's own defaults,
 * which is the smallest possible footprint for a feature most machines never
 * use.
 *
 * updater.js sets allowDowngrade back to false regardless. This is belt and
 * braces on a property that decides whether a shop's app can go BACKWARDS past
 * a database migration.
 */
function feedChannel(channel) {
  const value = String(channel || '').trim().toLowerCase()
  if (!value || value === DEFAULT_CHANNEL) return null
  return value
}

/**
 * Where the answer is remembered between launches.
 *
 * In userData rather than beside the executable, because it is per-installation
 * state rather than a property of the build — an update replaces the
 * application directory and must not take a machine's channel with it.
 */
function cachePath() {
  try {
    return path.join(app.getPath('userData'), 'update-channel')
  } catch {
    /* Called before `ready`, or in a context with no app paths. */
    return null
  }
}

/**
 * This machine's id, as the licence path knows it.
 *
 * The same generated UUID preload.js writes and mirrors into a cookie — read
 * straight off disk here because a background timer has no renderer to ask and
 * no request scope to read a cookie from.
 *
 * A machine with no id yet gets the default channel, which is correct: it has
 * never registered as a device, so the control panel has nothing to say about
 * it.
 */
function deviceSerial() {
  try {
    const file = path.join(app.getPath('userData'), 'device-id')
    const value = fs.readFileSync(file, 'utf8').trim()
    return value || null
  } catch {
    return null
  }
}

/**
 * The channel to use right now, without asking anybody.
 *
 * ── THE ENVIRONMENT WINS, AND ONLY EVER ON A DEV MACHINE ───────────────────
 *
 * ODYSSEY_UPDATE_CHANNEL is how the feature is exercised without a control
 * panel and how support pins a machine while diagnosing one. It is read from
 * the process environment and is NOT in the KEYS list in
 * scripts/make-build-defaults.mjs, so it cannot be baked into an installer: a
 * customer's build has no way to be born on beta.
 */
function current() {
  const override = String(process.env.ODYSSEY_UPDATE_CHANNEL || '').trim().toLowerCase()
  if (override) return override

  const file = cachePath()
  if (!file) return DEFAULT_CHANNEL
  try {
    const value = fs.readFileSync(file, 'utf8').trim().toLowerCase()
    return value || DEFAULT_CHANNEL
  } catch {
    /* Never written, or deleted. Both mean "nobody has told this machine
       otherwise", which is the default. */
    return DEFAULT_CHANNEL
  }
}

/**
 * Ask the control panel, and remember the answer.
 *
 * ── VIA THE APP'S OWN ROUTE, NOT DIRECTLY ───────────────────────────────────
 *
 * The call has to be SIGNED with the site key, and everything that does that
 * lives in the Next server's module tree — which runs in this process but is
 * deliberately not on the shell's resolution path (see appModules.js). An HTTP
 * call to a route the server already serves keeps the shell independent of what
 * Next traced into its build, exactly as licenceRefresh.js does for the licence
 * lease.
 *
 * Never throws and never rejects. The caller is a timer with nobody waiting on
 * it, and a machine that cannot reach the portal keeps whatever it last knew.
 */
async function refresh(origin) {
  if (!origin) return current()

  const serial = deviceSerial()
  if (!serial) return current()

  try {
    const response = await fetch(`${origin}/api/updates/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial }),
      /* Longer than the portal's own four seconds, and for the same reason as
         the licence refresh: nobody is waiting, and giving up early on a slow
         line costs an answer for no benefit. */
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return current()

    const body = await response.json().catch(() => null)
    const channel = String(body?.channel || '').trim().toLowerCase()
    if (!channel) return current()

    remember(channel)
    return channel
  } catch {
    /* No line, the server not up yet, or the twenty seconds ran out. The
       cached answer stands. */
    return current()
  }
}

/**
 * Write the answer down, and say so when it changes.
 *
 * The log line is the whole audit trail a support call has for "why did this
 * machine install that build", so it names both sides rather than just the new
 * one. Written only on a CHANGE — a line every four hours saying the channel is
 * still stable is a line nobody reads.
 */
function remember(channel) {
  const file = cachePath()
  if (!file) return
  const before = current()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, channel, 'utf8')
    if (before !== channel) {
      console.log(`[updater] update channel changed: ${before} -> ${channel}`)
    }
  } catch (err) {
    /* A locked profile or a read-only userData. The channel then simply does
       not persist across a restart, and every launch re-asks — which works,
       just less efficiently. Not worth failing anything over. */
    console.warn('[updater] could not save the update channel:', err?.message || err)
  }
}

module.exports = { current, refresh, feedChannel, DEFAULT_CHANNEL }
