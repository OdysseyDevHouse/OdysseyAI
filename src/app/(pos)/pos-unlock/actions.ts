'use server'

import { activeSiteIds } from '@/lib/sites'
import { siteQueryOne } from '@/lib/siteDb'
import { signInWithPin } from '@/lib/site/users'
import { capabilitiesForRole, can } from '@/lib/site/permissions'
import { createSessionToken, setSessionCookie } from '@/lib/session'
import { createTillToken, setTillCookie } from '@/lib/tillSession'

/**
 * Getting a till back in after its browser session has lapsed.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * A `SESSION_COOKIE` lasts twelve hours. A till that has been offline overnight
 * wakes with an expired one and a full outbox. `proxy.ts` would send it to the
 * back-office login form — where nobody at a counter at 07:00 knows the password,
 * and where the shell it needs in order to FLUSH that outbox sits behind the
 * redirect. The shop cannot trade and cannot bank yesterday's takings.
 *
 * ── THE SECURITY DECISION, STATED PLAINLY ─────────────────────────────────
 *
 * A valid till PIN alone creates a browser session. That is a real widening of
 * what a PIN can do, and it was taken deliberately. It is bounded four ways:
 *
 *   1. The SITE IS NOT CHOSEN by whoever is at the screen. It comes from the
 *      terminal claim this machine already holds — a row somebody with back-office
 *      access created. An unclaimed machine cannot unlock at all, so this is not a
 *      way into an arbitrary shop.
 *   2. `sales.till` is required. A PIN that cannot work a till cannot mint a
 *      session with this.
 *   3. PINs already gate the entire money-handling half of the app, and
 *      `pinInUse` forbids repeated and sequential digits.
 *   4. The alternative is a till nobody present can unlock, which is worse: the
 *      shop stops trading and the unsynced sales stay unsynced.
 */

export type UnlockResult =
  | { ok: true; name: string }
  | { ok: false; error: string }

/**
 * Which site this machine belongs to.
 *
 * Resolved from the DEVICE ID against every active site's `terminals` table. The
 * device id is not a credential — it is a public identifier the browser hands over
 * — so this proves nothing on its own; what it does is answer "which shop is this
 * machine registered to" without asking the person at the screen, so they cannot
 * point an unlock at a site they have no business in.
 *
 * The fan-out is bounded by the number of active sites and short-circuits on the
 * first match. It runs before any PIN is checked, so an unclaimed device is refused
 * without a single bcrypt comparison — which also means this endpoint cannot be
 * used to fish for valid PINs across every shop on the platform.
 */
async function siteForDevice(deviceId: string): Promise<number | null> {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(deviceId)) return null
  for (const siteId of await activeSiteIds()) {
    const row = await siteQueryOne<{ id: number }>(
      siteId,
      'SELECT id FROM terminals WHERE device_id = ? AND is_active = 1 LIMIT 1',
      [deviceId],
    ).catch(() => null)
    if (row) return siteId
  }
  return null
}

export async function posUnlockAction(deviceId: string, pin: string): Promise<UnlockResult> {
  const siteId = await siteForDevice(deviceId)
  if (siteId === null) {
    // Says which problem it is, because the two need different people: an
    // unclaimed till needs somebody with back-office access, a wrong PIN needs the
    // person standing there to try again.
    return {
      ok: false,
      error: 'This machine is not registered as a till. Someone with back-office access must claim it first.',
    }
  }

  const result = await signInWithPin(siteId, pin)
  if (!result.ok) return result

  const capabilities = await capabilitiesForRole(siteId, result.user.roleId)
  if (!can(capabilities, 'sales.till')) {
    return { ok: false, error: `${result.user.name} is not allowed to use the till.` }
  }

  // BOTH cookies. The browser session is what stops proxy.ts redirecting the next
  // request; the till session is who the sales belong to. Minting only the first
  // would put the operator back at the PIN pad immediately.
  //
  // ── DELIBERATELY NO `sid`, SO THIS SESSION IS NEVER EVICTED ──────────────
  //
  // The back office allows one live session per user (src/lib/control/sessions.ts),
  // and a token carrying no `sid` is exempt from that. It has to be: this mints a
  // back-office session from a PIN alone, so enrolling it would mean a waiter
  // unlocking a till signs the manager out of the back office — and the manager
  // signing back in bounces the till to the PIN pad, mid-service.
  //
  // Tills are limited by DEVICE instead (src/lib/control/devices.ts), which is the
  // right lever: a shop pays per till, not per person standing at one. If this is
  // ever changed to call `finishSignIn`, that exemption disappears silently.
  await setSessionCookie(
    await createSessionToken({
      userId: result.user.id,
      email: result.user.email ?? '',
      name: result.user.name,
      siteId,
      /* False, and it has to be: the flag exists to force a back-office password
         change before anything else, and a POS-only operator has no password to
         change. Setting it true would trap the till on a screen the person at the
         counter cannot clear. */
      mustChangePassword: false,
    }),
  )
  await setTillCookie(
    await createTillToken({ userId: result.user.id, name: result.user.name, siteId }),
  )

  return { ok: true, name: result.user.name }
}
