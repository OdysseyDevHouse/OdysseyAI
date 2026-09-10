import 'server-only'
import { portalConfig, send } from './portalApi'
import type { SiteGrant, UserSiteAccess, ProvisionInput, ProvisionResult } from '../controlUsers'

/**
 * Staff and permissions, asked over HTTPS instead of a MySQL socket.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Setup → Staff and permissions was the last screen in the app with no portal
 * path at all, and on a desktop install that did not mean a degraded screen: it
 * meant a dead one. `pool()` refuses to open a control-database socket in a
 * packaged build — deliberately, see db.ts — so `siteGrantsFor` threw before it
 * queried anything, the server component threw with it, and the shop was shown
 * React error #441 and a digest number.
 *
 * Billing and Tills already had this treatment (billingPortal, devicesPortal).
 * This is the third and last of them.
 *
 * ── HOW THIS RELATES TO controlUsers.ts ─────────────────────────────────────
 *
 * Exactly as devicesPortal relates to devices.ts: that file keeps the SQL and
 * keeps the exported API, and each of its functions asks here first and falls
 * through to its own query when this returns null. Callers — the page, the save
 * action, userSync — are unchanged and unaware. The transport moved; the rules
 * did not.
 *
 * The portal runs the same logic against the same tables; its usersRoutes.ts is
 * a faithful port of controlUsers.ts, comments included.
 *
 * ── WHEN THIS RETURNS null, AND WHY THAT IS NOT AN ERROR ────────────────────
 *
 * The same three cases as devicesPortal, all meaning "ask the database
 * yourself": no portal key, unreachable, or an answer that was not an answer.
 *
 * A REFUSAL is none of those. If the portal says the granter does not belong to
 * this store, that is an answer — logged, and still degraded to SQL on a cloud
 * install where SQL works, because a settings screen that shows nothing is
 * worse than one reached the old way while somebody looks at the key. On a
 * desktop install the fallback throws and the screen fails loudly, which is the
 * correct outcome for a key that is genuinely wrong.
 *
 * ── WHY THE WRITES ARE HERE TOO ─────────────────────────────────────────────
 *
 * A read-only port would have made the screen render and every button on it
 * fail. `provision` and `revoke` change what somebody may open, and the check
 * that bounds them — a granter may only hand out stores they hold themselves —
 * runs on the server in both transports. See usersRoutes.ts for why that is
 * enough over a machine key.
 */

/** Is there anything to ask? Cheap, and read per call so a test can flip it. */
export function portalAvailable(): boolean {
  return portalConfig() !== null
}

/**
 * Report a refusal once, where somebody will see it.
 *
 * Not thrown, for the same reason as devicesPortal: the caller degrades rather
 * than stopping, and a stack trace on a shop floor helps nobody.
 */
function refused(what: string, error: string, code: string): null {
  console.error(`[portal] ${what} refused (${code}): ${error}`)
  return null
}

/** Everybody the control panel says may open the signing store. */
export async function accountsWithAccessTo(): Promise<
  { id: number; email: string; fullName: string }[] | null
> {
  if (!portalAvailable()) return null
  const res = await send<{ accounts: { id: number; email: string; fullName: string }[] }>(
    'GET',
    '/users/accounts',
  )
  if (res.ok) return res.data.accounts
  if (res.reason === 'refused') return refused('users/accounts', res.error, res.code)
  return null
}

/** Every store the granter may administer, with whether `target` holds it. */
export async function siteGrantsFor(
  granterUserId: number,
  targetControlUserId: number | null,
): Promise<SiteGrant[] | null> {
  if (!portalAvailable()) return null
  const res = await send<{ grants: SiteGrant[] }>('POST', '/users/grants', {
    granter: granterUserId,
    target: targetControlUserId,
  })
  if (res.ok) return res.data.grants
  if (res.reason === 'refused') return refused('users/grants', res.error, res.code)
  return null
}

/**
 * What these people may already open.
 *
 * ── AN EMPTY LIST IS ANSWERED WITHOUT A ROUND TRIP ──────────────────────────
 *
 * A store whose users are all till-only has no control ids to ask about, and
 * the SQL path already short-circuits that case. Sending it anyway would spend
 * a signed call on a question with one possible answer.
 */
export async function accessForControlUsers(
  granterUserId: number,
  controlUserIds: number[],
): Promise<Record<number, UserSiteAccess> | null> {
  if (!portalAvailable()) return null
  if (!granterUserId || !controlUserIds.length) return {}
  const res = await send<{ access: Record<number, UserSiteAccess> }>('POST', '/users/access', {
    granter: granterUserId,
    userIds: controlUserIds,
  })
  if (res.ok) return res.data.access
  if (res.reason === 'refused') return refused('users/access', res.error, res.code)
  return null
}

/**
 * The id behind an email address, or null — and nothing else about it.
 *
 * ── WHY AN ID AND NOT AN ACCOUNT ────────────────────────────────────────────
 *
 * The SQL path reads the whole cp2_users row because it is already inside that
 * database. This transport is not, and the portal deliberately answers with an
 * id alone: a site key is a shop's machine credential, and a route that named
 * the holder of any address on the platform would make every shop a directory
 * of every other shop's staff. The one caller only ever wanted the id — see
 * controlAccountIdForEmail in controlUsers.ts.
 *
 * `undefined` distinguishes "could not ask" from `null`, which is a real answer
 * meaning no such account. Getting those two the wrong way round would create a
 * second account for somebody who already has one.
 */
export async function controlAccountIdForEmail(email: string): Promise<number | null | undefined> {
  if (!portalAvailable()) return undefined
  const res = await send<{ id: number | null }>('POST', '/users/lookup-email', { email })
  if (res.ok) return res.data.id
  if (res.reason === 'refused') {
    refused('users/lookup-email', res.error, res.code)
    return undefined
  }
  return undefined
}

/**
 * Create or update a back-office account and its store access.
 *
 * ── A REFUSAL IS NOT A null HERE ────────────────────────────────────────────
 *
 * Every other function in this file degrades to SQL on a refusal because it is
 * reading. This one writes, and re-running a rejected save against the direct
 * connection would mean a key the portal will not accept quietly reverting the
 * one screen that creates logins to the socket this exists to stop needing.
 *
 * So a refusal comes back as a ProvisionResult carrying the portal's own
 * message, which the screen already knows how to show. Only "could not ask at
 * all" returns null and falls through.
 */
export async function provisionControlAccount(
  granterUserId: number,
  existingId: number | null,
  input: ProvisionInput,
): Promise<ProvisionResult | null> {
  if (!portalAvailable()) return null
  const res = await send<ProvisionResult>('POST', '/users/provision', {
    granter: granterUserId,
    existingId,
    input,
  })
  if (res.ok) return res.data
  if (res.reason === 'refused') {
    refused('users/provision', res.error, res.code)
    return { ok: false, error: 'This store could not be given permission to save that account.' }
  }
  return null
}

/** Take one person's access to the signing store away. True when it was done. */
export async function revokeSiteAccess(controlUserId: number): Promise<boolean> {
  if (!portalAvailable()) return false
  const res = await send<{ ok: boolean }>('POST', '/users/revoke', { controlUserId })
  if (res.ok) return true
  if (res.reason === 'refused') {
    refused('users/revoke', res.error, res.code)
    return false
  }
  return false
}
