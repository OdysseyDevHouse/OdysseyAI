// Renewing the licence lease on a timer, instead of on every click.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// The Next server runs IN-PROCESS here, on a shop's counter. Its guard chain was
// written for the cloud deployment, where the server sits in the same rack as
// the control database and a control query costs a fraction of a millisecond.
// On this machine those same queries cross the internet — and the control
// database is IP-whitelisted to the office, so outside that building they do not
// merely get slow, they fail after a TCP timeout on every single click.
//
// So the machine now answers from its own licence_lease row and comes here to
// renew it. Five hours, against a lease that lasts seven days: ~33 chances to
// reconnect before a shop locks. A poor line is never noticed; a machine
// unplugged to avoid paying still locks on schedule.
//
// ── WHY IT IS AN HTTP CALL AND NOT A require() ──────────────────────────────
//
// A packaged build carries two dependency trees on purpose (see appModules.js),
// and everything the renewal needs lives in the app's, not the shell's. Calling
// a route the server already serves keeps the shell independent of what Next
// happened to trace into the standalone output. main.js already waits on
// /api/health exactly this way.
const { REFRESH_MS, FIRST_RUN_MS } = require('./licenceRefreshRules')

let timer = null

/**
 * Ask the server to renew, and say what happened.
 *
 * Never throws and never rejects. A refresh that fails is the ordinary state of
 * a shop with no line: the existing lease still stands, and the lock screen —
 * which reads the same lease, from the LOCAL database — is what eventually acts
 * on a machine that has been away too long. Nothing here decides that.
 */
async function refreshOnce(origin) {
  try {
    const response = await fetch(`${origin}/api/licence/refresh`, {
      method: 'POST',
      /* Longer than the portal's four seconds: nobody is waiting on this, and a
         renewal that gives up early on a slow line costs the shop one of its
         thirty-odd attempts for no reason. */
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      console.warn(`[licence] refresh refused with ${response.status}`)
      return false
    }

    const body = await response.json().catch(() => null)
    if (body && body.refreshed) {
      console.log('[licence] lease renewed')
      return true
    }

    /* Not a warning. "Could not reach the control panel" is what this looks like
       on every machine that is simply offline, and a red line every five hours
       teaches everybody to stop reading the log. */
    console.log(`[licence] lease not renewed (${(body && body.error) || 'no answer'})`)
    return false
  } catch (err) {
    console.log(`[licence] refresh could not run: ${err && err.message ? err.message : err}`)
    return false
  }
}

/**
 * Start the timer. Local installs only.
 *
 * `origin` is the app's own http://127.0.0.1:PORT, already resolved by main.js
 * before the window loads — so this is only ever called once the server is up.
 */
function start(origin, mode) {
  /* A cloud install reaches the control database over the same line as
     everything else it needs, so it keeps no lease and has nothing to renew. */
  if (mode !== 'local') return
  if (timer) return

  /* Not at the instant of launch: the first minute belongs to opening the shop,
     and the entitlement read the first page does will renew the lease anyway if
     the line is up. Same reasoning as updater.js's thirty seconds, one step
     further back because this is even less urgent. */
  setTimeout(() => void refreshOnce(origin), FIRST_RUN_MS)
  timer = setInterval(() => void refreshOnce(origin), REFRESH_MS)
}

function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = { start, stop, refreshOnce }
