'use server'

import { requireSiteId } from '@/lib/auth'
import { signInWithPin } from '@/lib/site/users'
import { capabilitiesForRole, can } from '@/lib/site/permissions'
import { createTillToken, setTillCookie, clearTillCookie } from '@/lib/tillSession'

/**
 * Signing in at the invoicing counter.
 *
 * PIN-only, like the till: a PIN is unique per site — enforced when it is saved
 * — so it alone answers "who is this".
 *
 * ── WHY THIS IS THE TILL'S SESSION AND NOT A SECOND ONE ───────────────────
 *
 * It mints the SAME `odyssey_till` cookie. A counter clerk and a cashier are
 * the same kind of fact — a person standing at a machine for a stint, distinct
 * from the twelve-hour browser session naming the company — and every server
 * action that attributes work already reads that cookie through
 * `withTillOperator`. A second parallel cookie would mean two identities that
 * could disagree, and every action having to decide which one it meant.
 *
 * It also means a clerk who signed in at the till is already signed in here.
 * That is correct rather than a shortcut: one person, one shop, one PIN.
 *
 * ── AND WHY THE GATE IS `sales.till` ──────────────────────────────────────
 *
 * Not `sales.view`, which is a back-office read right a bookkeeper may hold
 * without ever standing at a counter. `sales.till` is "use the till", and the
 * shift actions this window now shares already require exactly it — gating the
 * door more loosely than the cash drawer behind it would be the wrong way
 * round.
 */

export type CounterSignInResult = { ok: true; name: string } | { ok: false; error: string }

/**
 * @param windowId This tab's id, from `ensureWindowId()`. Signed into the token
 *   so the session dies when the window does — see `src/lib/windowSession.ts`.
 *   The CLIENT supplies it, and that is safe for the reason given there: the
 *   value is not a secret, and it only ever grants access to the one tab that
 *   already knows it.
 */
export async function counterSignInAction(
  pin: string,
  windowId: string,
): Promise<CounterSignInResult> {
  const siteId = await requireSiteId()

  const result = await signInWithPin(siteId, pin)
  if (!result.ok) return result

  const capabilities = await capabilitiesForRole(siteId, result.user.roleId)
  if (!can(capabilities, 'sales.till')) {
    return { ok: false, error: `${result.user.name} is not allowed to use invoicing.` }
  }

  await setTillCookie(
    await createTillToken({
      userId: result.user.id,
      name: result.user.name,
      siteId,
      /* '' when the tab could not mint an id (storage blocked). Left UNSET
         rather than stored as an empty string: `windowMatches` treats an absent
         claim as unbound, so such a browser gets the old eight-hour behaviour
         instead of a counter that can never stay signed in. */
      wid: windowId || undefined,
    }),
  )

  return { ok: true, name: result.user.name }
}

/**
 * Handing the counter to the next person.
 *
 * Clears the till cookie only — the browser session stays, so the machine is
 * still signed in to the shop and the next clerk needs a PIN rather than a
 * full login.
 */
export async function counterSignOutAction(): Promise<void> {
  await clearTillCookie()
}
