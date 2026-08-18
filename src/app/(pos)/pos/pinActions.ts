'use server'

import { requireSiteId } from '@/lib/auth'
import { signInWithPin } from '@/lib/site/users'
import { capabilitiesForRole, can, type Capability } from '@/lib/site/permissions'
import { createTillToken, setTillCookie, clearTillCookie } from '@/lib/tillSession'
import { createOverrideToken } from '@/lib/overrideToken'
import { logActivity } from '@/lib/site/activityLog'

/**
 * Signing in at the till, and authorising something the operator may not do.
 *
 * Both are PIN-only. There is no username because a PIN is unique per site —
 * enforced when it is saved — so the PIN alone answers "who is this".
 */

export type PinSignInActionResult =
  | { ok: true; name: string; canOverrideDiscount: boolean }
  | { ok: false; error: string }

/**
 * @param windowId This tab's id, from `ensureWindowId()`. Signed into the token
 *   so the session dies with the window rather than lasting the full eight
 *   hours — see `src/lib/windowSession.ts`.
 */
export async function tillSignInAction(
  pin: string,
  windowId: string,
): Promise<PinSignInActionResult> {
  const siteId = await requireSiteId()

  const result = await signInWithPin(siteId, pin)
  if (!result.ok) return result

  const capabilities = await capabilitiesForRole(siteId, result.user.roleId)
  if (!can(capabilities, 'sales.till')) {
    return { ok: false, error: `${result.user.name} is not allowed to use the till.` }
  }

  await setTillCookie(
    await createTillToken({
      userId: result.user.id,
      name: result.user.name,
      siteId,
      /* Unset rather than '' when the tab could not mint one — see the note in
         (invoicing)/pinActions.ts. */
      wid: windowId || undefined,
    }),
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
  | { ok: true; authorisedBy: string; userId: number; token: string }
  | { ok: false; error: string }

/** What was being authorised — the words the audit row keeps. */
export type OverrideContext = {
  /** Human sentence: "25% discount on Bread", "Void INV101187". */
  action: string
  amount?: number
  documentId?: number | null
  terminalCode?: string | null
  cashierName: string
}

/**
 * A supervisor authorising one action without taking over the till.
 *
 * Deliberately does NOT change who is signed in. The sale still belongs to the
 * cashier who rang it up — a manager walking over to approve a discount is not
 * the person serving the customer, and recording it the other way would put
 * their name on takings they never handled.
 *
 * Returns a SIGNED TOKEN (two minutes, one capability) the till attaches to
 * exactly one server action, which verifies it instead of trusting a name the
 * client typed. The audit row is written HERE, at authorisation — a manager
 * who typed their PIN authorised something even if the sale then died — with
 * the manager as the actor: "who authorised" is the question the row answers.
 * A refusal by someone who cannot authorise is a row too; a PIN typed at a
 * refusal screen is a fact worth keeping either way.
 */
export async function tillOverrideAction(
  pin: string,
  capability: Capability,
  context: OverrideContext,
): Promise<OverrideResult> {
  const siteId = await requireSiteId()

  const result = await signInWithPin(siteId, pin)
  if (!result.ok) return result

  const detail = [
    context.action,
    context.cashierName && `cashier ${context.cashierName}`,
    context.amount !== undefined && `R${context.amount.toFixed(2)}`,
    context.terminalCode && `till ${context.terminalCode}`,
  ]
    .filter(Boolean)
    .join(' · ')

  const capabilities = await capabilitiesForRole(siteId, result.user.roleId)
  if (!can(capabilities, capability)) {
    await logActivity(siteId, { userId: result.user.id, userName: result.user.name }, {
      entity: 'pos_override',
      entityId: context.documentId ?? null,
      action: `${capability}.refused`,
      detail,
    })
    return { ok: false, error: `${result.user.name} cannot authorise that either.` }
  }

  await logActivity(siteId, { userId: result.user.id, userName: result.user.name }, {
    entity: 'pos_override',
    entityId: context.documentId ?? null,
    action: capability,
    detail,
  })

  return {
    ok: true,
    authorisedBy: result.user.name,
    userId: result.user.id,
    token: await createOverrideToken({
      siteId,
      userId: result.user.id,
      userName: result.user.name,
      capability,
    }),
  }
}
