'use server'

import { requireSiteId } from '@/lib/auth'
import { signInWithPin } from '@/lib/site/users'
import { capabilitiesForRole, can, type Capability } from '@/lib/site/permissions'
import { createTillToken, setTillCookie, clearTillCookie } from '@/lib/tillSession'

/**
 * Signing in at the till, and authorising something the operator may not do.
 *
 * Both are PIN-only. There is no username because a PIN is unique per site —
 * enforced when it is saved — so the PIN alone answers "who is this".
 */

export type PinSignInActionResult =
  | { ok: true; name: string; canOverrideDiscount: boolean }
  | { ok: false; error: string }

export async function tillSignInAction(pin: string): Promise<PinSignInActionResult> {
  const siteId = await requireSiteId()

  const result = await signInWithPin(siteId, pin)
  if (!result.ok) return result

  const capabilities = await capabilitiesForRole(siteId, result.user.roleId)
  if (!can(capabilities, 'sales.till')) {
    return { ok: false, error: `${result.user.name} is not allowed to use the till.` }
  }

  await setTillCookie(
    await createTillToken({ userId: result.user.id, name: result.user.name, siteId }),
  )

  return {
    ok: true,
    name: result.user.name,
    canOverrideDiscount: can(capabilities, 'sales.discount_override'),
  }
}

export async function tillSignOutAction(): Promise<void> {
  await clearTillCookie()
}

export type OverrideResult =
  | { ok: true; authorisedBy: string }
  | { ok: false; error: string }

/**
 * A supervisor authorising one action without taking over the till.
 *
 * Deliberately does NOT change who is signed in. The sale still belongs to the
 * cashier who rang it up — a manager walking over to approve a discount is not
 * the person serving the customer, and recording it the other way would put
 * their name on takings they never handled.
 */
export async function tillOverrideAction(
  pin: string,
  capability: Capability,
): Promise<OverrideResult> {
  const siteId = await requireSiteId()

  const result = await signInWithPin(siteId, pin)
  if (!result.ok) return result

  const capabilities = await capabilitiesForRole(siteId, result.user.roleId)
  if (!can(capabilities, capability)) {
    return { ok: false, error: `${result.user.name} cannot authorise that either.` }
  }

  return { ok: true, authorisedBy: result.user.name }
}
