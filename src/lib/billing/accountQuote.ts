import 'server-only'
import {
  sitesForAccount,
  holdingsForSites,
  currentPrices,
  deviceOrdersFor,
} from '@/lib/control/modules'
import { quoteFor, type Quote } from './pricing'

/**
 * What an account owes each month, derived from the database alone.
 *
 * ── ONE DEFINITION, BECAUSE TWO WOULD DRIFT ────────────────────────────────
 *
 * Three things need this number and they must never disagree: the checkout
 * that instructs PayFast what to collect, the sync that pushes a plan change
 * to PayFast, and the reconciliation that notices the two have parted company.
 * If the checkout and the sync each computed it, the sync would eventually
 * "correct" the price to something the customer never agreed to.
 *
 * ── IT DIFFERS FROM WHAT THE SCREEN SHOWS, ON PURPOSE ──────────────────────
 *
 * The billing screen renders only the stores the signed-in user may open — an
 * account is a billing fact, not an access grant, and listing the others would
 * leak them. Billing has the opposite duty: it charges for EVERY store on the
 * account, including ones the person looking at the screen cannot see.
 *
 * The multi-store discount follows the same rule. It is a property of the
 * account, so the store count passed to `quoteFor` is the full one — using the
 * visible subset would hand a discount to whoever has the narrowest access.
 */

export const BILLING_VAT_PERCENT = 15

export type AccountQuote = {
  quote: Quote
  /** Every site on the account, not merely the visible ones. */
  siteIds: number[]
  /** VAT-inclusive monthly total — the figure PayFast is told to collect. */
  total: number
}

export async function quoteForAccount(accountId: number): Promise<AccountQuote> {
  const sites = await sitesForAccount(accountId)
  const siteIds = sites.map((s) => s.siteId)

  const [holdings, prices, devices] = await Promise.all([
    holdingsForSites(siteIds),
    currentPrices(),
    deviceOrdersFor(siteIds),
  ])

  /* The REQUESTED till count, not the provisioned one. A shop that has ordered
     a third till is billed for it from the moment they agree to it; the
     licence itself is created when the money arrives. */
  const deviceCounts: Record<number, number> = {}
  for (const d of devices) deviceCounts[d.siteId] = d.requested

  const quote = quoteFor(holdings, deviceCounts, prices, BILLING_VAT_PERCENT, sites.length)

  return { quote, siteIds, total: quote.total }
}
