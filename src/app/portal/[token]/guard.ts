import 'server-only'
import { redirect } from 'next/navigation'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { getCustomerSession } from '@/lib/customerSession'
import { portalSettings, portalIsOpen, type PortalSettings } from '@/lib/site/portalAuth'

/**
 * The one door every portal page goes through.
 *
 * ── WHY A SHARED GUARD RATHER THAN A CHECK PER PAGE ────────────────────────
 *
 * Four checks have to happen in order on every single request, and a page that
 * forgot one would not fail visibly — it would quietly serve somebody else's
 * work. Putting them in one function means the order is written once:
 *
 *   1. the token in the path names a real site
 *   2. the portal is switched on for that site
 *   3. there is a customer session
 *   4. that session was minted AT THIS SITE
 *
 * Step 4 is the one that is easy to miss and expensive to get wrong. Customer
 * ids are per-site, so a session from business A presented at business B would
 * otherwise resolve to whichever customer happens to hold that id there.
 * getCustomerSession takes the siteId and refuses a mismatch, which is why it
 * is called with the token's site rather than the cookie's.
 */

export type PortalContext = {
  siteId: number
  customerId: number
  customerName: string
  token: string
  settings: PortalSettings
}

/**
 * Resolve the signed-in customer, or redirect.
 *
 * Never returns null: a caller that has a context has a customer, so there is no
 * "if (!ctx)" for anybody to leave out.
 */
export async function requireCustomer(token: string): Promise<PortalContext> {
  const siteId = await verifyPortalToken(token)
  // A bad token has no sign-in page to send anybody to, so this is the one exit
  // that goes nowhere useful. It matches what a bad storefront token does.
  if (siteId === null) redirect('/')

  const settings = await portalSettings(siteId)
  if (!portalIsOpen(settings)) redirect(`/portal/${token}/closed`)

  const session = await getCustomerSession(siteId)
  if (!session) redirect(`/portal/${token}`)

  return {
    siteId,
    customerId: session.customerId,
    customerName: session.name,
    token,
    settings,
  }
}

/**
 * The sections a portal page can belong to.
 *
 * 'account' is the profile page — it needs only that the account side is on at
 * all, which is what makes it the landing page for a statements-only shop.
 */
export type PortalSection = 'jobs' | 'account' | 'transactions' | 'statement'

/**
 * Resolve the customer AND check they may see this section.
 *
 * ── WHY THE SECTION CHECK IS NOT LEFT TO EACH PAGE ─────────────────────────
 *
 * Since the portal split into two halves, "signed in" no longer means "may see
 * everything". A jobs page reached on a statements-only site, or a statement
 * page on a site that switched statements off, would otherwise render happily —
 * the session is real and the customer is real, so nothing would look wrong.
 *
 * Redirecting rather than 404ing: the customer IS signed in and the page they
 * wanted simply is not on offer here, so the useful place to put them is the
 * part of their account that does exist.
 */
export async function requireSection(
  token: string,
  section: PortalSection,
): Promise<PortalContext> {
  const ctx = await requireCustomer(token)
  const { settings } = ctx

  const allowed =
    section === 'jobs'
      ? settings.isEnabled
      : section === 'account'
        ? settings.accountsEnabled
        : section === 'transactions'
          ? settings.showTransactions
          : settings.showStatement

  if (!allowed) redirect(portalHome(token, settings))
  return ctx
}

/**
 * The first page this portal actually has.
 *
 * One definition, because "where does a customer land" is asked by the sign-in
 * redirect, every refused section and the nav's back-link — and three copies of
 * the ordering is how one of them comes to point at a page that redirects.
 */
export function portalHome(token: string, settings: PortalSettings): string {
  if (settings.isEnabled) return `/portal/${token}/jobs`
  if (settings.accountsEnabled) return `/portal/${token}/account`
  // Neither half on. portalIsOpen would already have sent them to /closed, so
  // this is unreachable — but it must not be a link to nowhere if it ever is.
  return `/portal/${token}/closed`
}
