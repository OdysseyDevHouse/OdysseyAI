import 'server-only'
import { portalConfig, send } from './portalApi'
import type { BillingAccount, AccountSite, Holding, DeviceOrder } from './modules'
import type { Subscription, PaymentRow } from './subscriptions'

/**
 * Plan & billing, asked over HTTPS instead of a MySQL socket.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Every other screen a shop opens already had a portal path; this one did not.
 * The billing page read the control database directly on port 3306, which works
 * from a whitelisted office network and nowhere else — the same wall the setup
 * wizard hit. On a customer's Windows machine it was the last screen still
 * holding that socket open.
 *
 * ── ONE CALL, NOT SEVEN ─────────────────────────────────────────────────────
 *
 * The page needs account, sites, holdings, prices, devices, subscription and
 * payments before it can draw anything, and it already fetched them in a single
 * Promise.all. Over a shop's ADSL, seven signed round trips would be seven
 * times the wait for a screen that cannot render until it has all of them — the
 * same reasoning that made /licence/spots one call in devicesPortal.
 *
 * It also keeps the answer CONSISTENT. Holdings read before an operator's
 * change and prices read after it produce a total that never existed on any
 * invoice. One statement, one answer.
 *
 * ── WHEN THIS RETURNS null, AND WHY THAT IS NOT AN ERROR ────────────────────
 *
 * Same three cases as devicesPortal, and all three mean "ask the database
 * yourself": no portal key (a cloud install, the web build, a dev checkout),
 * unreachable (no line, DNS, or four seconds elapsed), or a malformed answer.
 *
 * A REFUSAL is none of those. If the portal says the signature did not verify,
 * that is an answer — logged, and still degraded to SQL, because a billing
 * screen that shows nothing is worse than one reached the old way while
 * somebody looks at the key.
 */

/** Exactly what GET /billing/summary answers. */
export type BillingSummary = {
  account: BillingAccount | null
  sites: AccountSite[]
  holdings: Holding[]
  prices: Record<string, number>
  devices: DeviceOrder[]
  subscription: Subscription | null
  payments: PaymentRow[]
  today: string
}

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

/**
 * The whole billing screen in one round trip, or null to use SQL.
 *
 * ── DATES CROSS THE WIRE AS STRINGS ─────────────────────────────────────────
 *
 * JSON has no date type, so `receivedAt` and friends arrive as ISO strings
 * where the SQL path produced Date objects. Rehydrated here rather than at the
 * call site: the page must not be able to tell which transport answered it, or
 * the two paths drift and only one of them is ever tested.
 *
 * The ISO *day* strings — startsOn, endsOn, billingDate, pendingFrom — stay
 * strings, because that is what the SQL path returns for them too.
 */
export async function summary(): Promise<BillingSummary | null> {
  if (!portalAvailable()) return null

  const res = await send<BillingSummary>('GET', '/billing/summary')
  if (res.ok) return rehydrate(res.data)
  if (res.reason === 'refused') return refused('billing/summary', res.error, res.code)
  return null
}

/** Turn the timestamps back into Dates, leaving ISO day strings alone. */
function rehydrate(raw: BillingSummary): BillingSummary {
  return {
    ...raw,
    /* syncedAt is the ONLY Date on a Subscription. billingDate,
       nextBillingOn, lastPaidOn, anniversaryOn and lastEscalatedOn are all ISO
       day strings on the SQL path too, so they are left exactly as they
       arrived. */
    subscription: raw.subscription
      ? { ...raw.subscription, syncedAt: toDate(raw.subscription.syncedAt) }
      : null,
    payments: raw.payments.map((p) => ({ ...p, receivedAt: toDate(p.receivedAt) })),
  }
}

/**
 * A wire value back to a Date.
 *
 * Deliberately tolerant of three inputs, because all three legitimately arrive:
 * null (no such timestamp), a string (this transport), and a Date (a caller
 * handing back something already rehydrated). An unparseable string becomes
 * null rather than an Invalid Date, which would render as "Invalid Date" on the
 * screen instead of as the blank the null path already draws.
 */
function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}
