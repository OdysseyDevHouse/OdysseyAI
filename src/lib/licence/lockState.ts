import 'server-only'
import { cache } from 'react'
import { readLease, leaseState, daysRemaining, daysSinceCheck } from './lease'
import { challengeFor } from './unlockCode'
import { leaseUnlockSecret } from './lease'

/**
 * Whether this machine may trade, decided on the SERVER.
 *
 * ── WHY NOT IN DesktopLicenceGate ───────────────────────────────────────────
 *
 * That component is a client component, and it fails open in three separate
 * places by design: no device id passes, a rejected check passes, and the
 * not-yet-loaded state renders the app. Every one of those is the right call
 * for what it does — refusing a shop over a licence-server hiccup is a worse
 * failure than a few minutes of unverified use.
 *
 * But it means an offline machine sails straight through it, which is exactly
 * the machine the seven-day rule exists for. A lock built there would be a lock
 * that never fires.
 *
 * So the lease is evaluated here, on the server, where the answer does not
 * depend on a network call that can fail permissively. The client gate keeps
 * its job — the live licence check, with its fail-open — and this decides the
 * separate question of whether an OFFLINE machine has been offline too long.
 *
 * ── WHAT IT COSTS ───────────────────────────────────────────────────────────
 *
 * One indexed single-row read from the site database per request, memoised per
 * request with cache(). On a cloud install it is not even that: keepsLease()
 * is false and this returns `open` without touching anything.
 */

export type LockState =
  /** Trade normally. */
  | { locked: false; warnDaysLeft: number | null }
  /**
   * Out of lease. The machine shows the lock screen and nothing else.
   *
   * Carries everything the screen needs to explain itself and to start an
   * unlock, because that screen must work with no network at all — it cannot
   * go back and ask for any of this.
   */
  | {
      locked: true
      reason: 'lease-expired'
      daysSilent: number
      licenceStatus: string
      challenge: string | null
      deviceSerial: string | null
    }

const OPEN: LockState = { locked: false, warnDaysLeft: null }

/**
 * Only a desktop build locks. A cloud install reaches the control database over
 * the same network as everything else it needs, so a lease there would be
 * written on every request and read on none.
 */
function keepsLease(): boolean {
  return process.env.APP_MODE === 'desktop'
}

/**
 * Is this machine locked out?
 *
 * Memoised per request: the layout asks, and so may a page and an action, and
 * they must all get the same answer within one render. The memo dies with the
 * request, so a lease renewed a second ago is visible immediately.
 */
export const lockState = cache(async (siteId: number): Promise<LockState> => {
  if (!keepsLease()) return OPEN

  try {
    const lease = await readLease(siteId)
    const state = leaseState(lease)

    /* Never checked in. NOT a lock: a fresh install has to be able to reach the
       screens that let it check in for the first time, and there is nothing yet
       to be dishonest about. */
    if (state.status === 'none') return OPEN

    if (state.status === 'current') {
      const left = daysRemaining(state.lease)
      return { locked: false, warnDaysLeft: left <= 2 ? left : null }
    }

    /* Expired. Build the challenge here, while a database is still reachable —
       the lock screen itself may be the last thing this machine can render. */
    let challenge: string | null = null
    try {
      const secret = await leaseUnlockSecret(siteId)
      if (secret) {
        challenge = challengeFor(secret, {
          siteId,
          deviceSerial: state.lease.deviceSerial,
          unlockCounter: state.lease.unlockCounter,
        })
      }
    } catch {
      /* No secret, or it will not decrypt. The screen then shows the device
         number alone and support falls back to re-registering the machine —
         degraded, but not a dead end. */
    }

    return {
      locked: true,
      reason: 'lease-expired',
      daysSilent: daysSinceCheck(state.lease),
      licenceStatus: state.lease.licenceStatus,
      challenge,
      deviceSerial: state.lease.deviceSerial,
    }
  } catch {
    /* The site database itself is unreachable. That is not a licence problem
       and must not be reported as one — the app will fail on its own terms a
       moment later, with an error about the database rather than a misleading
       one about a subscription. */
    return OPEN
  }
})
