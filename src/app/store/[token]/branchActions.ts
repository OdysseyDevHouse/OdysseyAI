'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { resolveStoreRouting } from '@/lib/storeRouting'
import { BRANCH_COOKIE_OPTIONS, branchCookieName } from '@/lib/branchChoice'
import { rankBranches, type Coords } from '@/lib/storeBranchPicker'

/**
 * Choosing, and finding, a branch.
 *
 * Both actions are reachable by anyone holding a storefront link, so neither
 * trusts its arguments: the branch a shopper claims is checked against the
 * group before it is written, and the coordinates are used and discarded.
 */

export type BranchChoiceState = { error: string | null }

/**
 * Remembers which branch a shopper picked.
 *
 * The id is validated by resolving it exactly as a page load would — a value
 * that does not name an open member of this group is refused, not written. That
 * is the same check on the same code path, so the cookie can never hold
 * something a page would then have to reject.
 */
export async function chooseBranchAction(
  _prev: BranchChoiceState,
  form: FormData,
): Promise<BranchChoiceState> {
  const token = String(form.get('token') ?? '')
  const branchSiteId = Number(form.get('branchSiteId'))

  if (!Number.isInteger(branchSiteId) || branchSiteId <= 0) {
    return { error: 'Please choose a store.' }
  }

  const routing = await resolveStoreRouting(token, branchSiteId)
  if (!routing) return { error: 'This shop is not available.' }
  if (!routing.isGroup) return { error: 'This shop has only one store.' }
  if (routing.branchSiteId !== branchSiteId) {
    // resolveStoreRouting silently falls back when an id is not a member, so a
    // mismatch here IS the refusal.
    return { error: 'That store is not taking online orders at the moment.' }
  }

  const jar = await cookies()
  jar.set(branchCookieName(routing.catalogueSiteId), String(branchSiteId), BRANCH_COOKIE_OPTIONS)

  // Every price, stock figure and delivery quote below this point belongs to a
  // different shop now, so the whole storefront is re-rendered rather than any
  // one path.
  revalidatePath('/store/[token]', 'layout')
  return { error: null }
}

export type NearestBranch = {
  siteId: number
  name: string
  km: number | null
}

/**
 * Orders the branches by distance from a one-off location reading.
 *
 * ── THE COORDINATES ARE NOT STORED ──────────────────────────────────────────
 *
 * They arrive, they sort a list, and they are gone when this function returns.
 * Nothing is written to a table, nothing is logged, and nothing about them
 * reaches the order. Migration 107 refused continuous GPS tracking of employees
 * on POPIA grounds — weak consent, no stated purpose, no retention story. This
 * is the opposite on all three: a single reading, taken only when the shopper
 * taps a button asking for it, used for one purpose stated in the same sentence,
 * and never persisted.
 */
export async function nearestBranchesAction(
  token: string,
  fix: Coords | null,
): Promise<NearestBranch[]> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return []

  const routing = await resolveStoreRouting(token)
  if (!routing?.isGroup) return []

  return rankBranches(
    routing.branches.map((b) => ({
      siteId: b.siteId,
      displayName: b.displayName,
      latitude: b.latitude,
      longitude: b.longitude,
      sortOrder: b.sortOrder,
    })),
    fix,
  ).map((b) => ({ siteId: b.siteId, name: b.displayName, km: b.km }))
}
