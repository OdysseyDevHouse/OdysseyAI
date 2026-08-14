import 'server-only'
import { redirect } from 'next/navigation'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { getCustomerSession } from '@/lib/customerSession'
import { portalSettings, type PortalSettings } from '@/lib/site/portalAuth'

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
  if (!settings.isEnabled) redirect(`/portal/${token}/closed`)

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
