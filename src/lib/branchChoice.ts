/**
 * Remembering which branch a shopper chose.
 *
 * ── WHY A COOKIE AND NOT localStorage ───────────────────────────────────────
 *
 * The SERVER has to know the branch before it renders the first byte: prices,
 * stock and the delivery quote are all resolved server-side. Keeping the choice
 * in localStorage would mean rendering head office's figures and then swapping
 * them in the browser, and a price that changes after the page has painted is
 * the single fastest way to lose a shopper's trust.
 *
 * ── WHY IT IS KEYED BY CATALOGUE ────────────────────────────────────────────
 *
 * Somebody may shop two different chains from the same browser. One cookie
 * would have the second chain's choice overwrite the first's, and a stale id
 * from another group is exactly the case resolveStoreRouting has to throw away.
 * Keying by the catalogue site keeps them apart at rest instead.
 *
 * This is a preference, not a credential. It names a shop that is already public
 * and grants nothing — a tampered value can only ever name a branch of the same
 * group, because the server checks membership before honouring it.
 */

/** Ninety days: long enough to survive a season, short enough to lapse. */
export const BRANCH_COOKIE_MAX_AGE = 60 * 60 * 24 * 90

export function branchCookieName(catalogueSiteId: number): string {
  return `ody_branch_${catalogueSiteId}`
}

/**
 * Reads a branch id out of a raw cookie value.
 *
 * Returns null for anything that is not a positive integer. The value is only a
 * CANDIDATE — resolveStoreRouting still checks it names an open member of this
 * group — so this is shape validation, not a trust decision.
 */
export function parseBranchCookie(raw: string | undefined | null): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** The attributes the cookie is written with, in one place so they cannot drift. */
export const BRANCH_COOKIE_OPTIONS = {
  // The storefront is the only thing that reads it; the back office never does.
  path: '/store',
  maxAge: BRANCH_COOKIE_MAX_AGE,
  sameSite: 'lax' as const,
  /*
   * httpOnly, even though this protects nothing. The picker does not need to
   * read it — the server tells the page which branch is current — and a cookie
   * that no script can touch is one fewer thing for a future change to start
   * depending on from the browser.
   */
  httpOnly: true,
  // Set on https and left off on a plain-http dev server, so the cookie is not
  // silently dropped locally.
  secure: process.env.NODE_ENV === 'production',
}
