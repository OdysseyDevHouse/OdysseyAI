'use server'

import { sitesForDevice, type DeviceSite } from '@/lib/site/terminals'
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
 *   1. The SITE IS NOT FREELY CHOSEN by whoever is at the screen. It comes from
 *      the terminal claims this machine already holds — rows somebody with
 *      back-office access created. An unclaimed machine cannot unlock at all, so
 *      this is not a way into an arbitrary shop.
 *
 *      A machine registered in SEVERAL shops now offers the choice between them,
 *      because one PC invoicing for two stores is an ordinary arrangement. That
 *      is still not a free parameter: the id is checked against this device's own
 *      list before it is used, so the choice is only ever between shops this
 *      machine was already registered to.
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
 * The shops this machine may unlock into.
 *
 * Resolved from the DEVICE ID against every active site's `terminals` table. The
 * device id is not a credential — it is a public identifier the browser hands over
 * — so this proves nothing on its own; what it does is answer "which shops is this
 * machine registered to" without asking the person at the screen, so they cannot
 * point an unlock at a site they have no business in.
 *
 * It runs before any PIN is checked, so an unclaimed device is refused without a
 * single bcrypt comparison — which also means this endpoint cannot be used to fish
 * for valid PINs across every shop on the platform.
 *
 * ── AND IT RETURNS ALL OF THEM, NOT THE FIRST ─────────────────────────────
 *
 * This used to stop at the first match, which was only safe because
 * `claimTerminal` refused a machine that was already a till somewhere else. That
 * refusal was wrong: an operator invoicing for two stores from one PC is an
 * ordinary arrangement, and the licence layer has always sold a separate licence
 * per store for exactly it. See `sitesForDevice`.
 */
export async function unlockSitesAction(deviceId: string): Promise<DeviceSite[]> {
  return sitesForDevice(deviceId)
}

/**
 * @param windowId This tab's id, from `ensureWindowId()`. Bound into the till
 *   token so an unlocked till still stops being that person's identity when the
 *   window is closed — see `src/lib/windowSession.ts`.
 *
 *   Only the TILL token carries it. The browser session minted below is
 *   deliberately left unbound: it answers "which shop's data is open", which is
 *   a property of the machine and not of the tab, and binding it would send the
 *   till back to `/pos-unlock` — a screen that mints a whole browser session
 *   from a PIN — every time somebody closed a window. The gate that should meet
 *   them there is the PIN pad, which is the till session's job.
 */
export async function posUnlockAction(
  deviceId: string,
  pin: string,
  windowId: string,
  /**
   * Which shop to unlock into, when this machine is a till in several.
   *
   * Omitted is the ordinary case — one shop, no question worth asking. Supplied
   * it must still be one of the machine's OWN sites: it arrives from a browser,
   * so it is a request rather than a fact, and honouring it unchecked would let
   * anybody unlock any site by passing its id.
   */
  siteChoice?: number,
): Promise<UnlockResult> {
  const sites = await sitesForDevice(deviceId)
  if (sites.length === 0) {
    // Says which problem it is, because the two need different people: an
    // unclaimed till needs somebody with back-office access, a wrong PIN needs the
    // person standing there to try again.
    return {
      ok: false,
      error: 'This machine is not registered as a till. Someone with back-office access must claim it first.',
    }
  }

  /*
   * VALIDATED AGAINST THIS MACHINE'S OWN LIST, never trusted.
   *
   * `sitesForDevice` is the authority on which shops this device may open, so a
   * choice that is not in it is refused rather than used — otherwise the site id
   * would be a free parameter and the whole point of resolving from the device
   * (that the person at the screen cannot pick a shop they have no business in)
   * would be gone.
   */
  const chosen =
    siteChoice === undefined
      ? sites[0]
      : sites.find((s) => s.siteId === siteChoice)
  if (!chosen) {
    return { ok: false, error: 'This machine is not registered as a till in that store.' }
  }

  /* More than one shop and nobody said which. Refused rather than guessed: this
     is precisely the ambiguity that used to be resolved by sort order, and a PIN
     typed at one counter opening another company's data is the failure being
     designed out. The screen asks first, so reaching here means it did not. */
  if (siteChoice === undefined && sites.length > 1) {
    return { ok: false, error: 'Choose which store this till is for.' }
  }

  const siteId = chosen.siteId

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
    await createTillToken({
      userId: result.user.id,
      name: result.user.name,
      siteId,
      wid: windowId || undefined,
    }),
  )

  return { ok: true, name: result.user.name }
}
