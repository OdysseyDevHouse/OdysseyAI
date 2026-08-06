import 'server-only'
import { round } from '../decimals'

/**
 * Charging interest on overdue debtors, and earning settlement discount on
 * creditors. Pure functions — no database, no siteId — for the reason
 * ledger.ts gives: this is the arithmetic most likely to be disputed, so it
 * must be reasoned about and tested on its own.
 *
 * ── A NOTE ON THE LAW ────────────────────────────────────────────────────
 *
 * Interest on a trade account in South Africa is not a free choice. The
 * National Credit Act requires the charge to be AGREED IN WRITING and caps the
 * rate; section 103(5) further caps the TOTAL interest recoverable on a
 * defaulted account at the outstanding principal — the "in duplum" rule.
 *
 * This file therefore does three things deliberately:
 *
 *   1. Defaults to charging NOTHING. An account with interest_enabled false
 *      never accrues, whatever the rate says.
 *   2. Applies in duplum as a hard ceiling, always, in `capInDuplum`.
 *   3. Never invents a rate. If nobody configured one, the answer is zero.
 *
 * It does NOT attempt to police the NCA's rate ceiling: that depends on the
 * repo rate on the day the agreement was signed and on which category the
 * agreement falls into, neither of which this system knows. The store is
 * responsible for setting a lawful rate; this code is responsible for not
 * quietly charging one nobody asked for.
 */

/** Simple daily accrual. 365 rather than 360 — banks differ, the Act does not. */
export const DAYS_IN_YEAR = 365

export type InterestTerms = {
  /** Annual nominal rate, e.g. 15.5 for 15.5% a year. */
  ratePct: number
  enabled: boolean
  /** Days past due before interest begins to accrue. */
  graceDays: number
}

/** An overdue item interest might be charged on. */
export type OverdueItem = {
  id: number
  /** Still unpaid, positive. */
  outstanding: number
  /** Days past the due date, as at the run date. */
  daysOverdue: number
}

/**
 * Interest on one overdue amount.
 *
 * SIMPLE interest, not compound: compounding requires the agreement to say so
 * explicitly, and charging it where it was not agreed is both unlawful and the
 * kind of error that only surfaces in a letter from an attorney.
 *
 * The grace period is subtracted from the days, not used as a threshold — an
 * invoice 10 days overdue with 7 days' grace accrues for 3 days, not 10. The
 * other reading (charge from day one once grace is passed) is a cliff that
 * makes day 8 cost more than day 7 by a week's interest.
 */
export function interestOn(item: OverdueItem, terms: InterestTerms): number {
  if (!terms.enabled) return 0
  if (terms.ratePct <= 0) return 0
  if (item.outstanding <= 0) return 0

  const chargeableDays = item.daysOverdue - Math.max(terms.graceDays, 0)
  if (chargeableDays <= 0) return 0

  const daily = terms.ratePct / 100 / DAYS_IN_YEAR
  return round(item.outstanding * daily * chargeableDays, 2)
}

/**
 * In duplum: interest already charged and unpaid may never exceed the capital
 * outstanding. Section 103(5) of the NCA, and settled common law before it.
 *
 * Returns what may still be charged, which is zero once the ceiling is reached.
 * Applied on every run rather than only on defaulted accounts, because an
 * account that quietly accrues past the cap for a year produces a balance that
 * cannot lawfully be collected and must then be written back — visibly, in
 * front of the customer.
 */
export function capInDuplum(
  proposedInterest: number,
  capitalOutstanding: number,
  interestAlreadyCharged: number,
): { amount: number; capped: boolean } {
  const headroom = round(capitalOutstanding - interestAlreadyCharged, 2)
  if (headroom <= 0) return { amount: 0, capped: true }
  if (proposedInterest <= headroom) return { amount: round(proposedInterest, 2), capped: false }
  return { amount: headroom, capped: true }
}

export type InterestCalculation = {
  /** What interest is charged on — the sum of chargeable overdue items. */
  base: number
  /** Weighted average days used, for the workings shown on screen. */
  days: number
  ratePct: number
  /** Before the in duplum cap. */
  gross: number
  /** After the cap, and after the minimum-charge test. */
  amount: number
  capped: boolean
  /** Set when the charge was dropped, and why. */
  skipReason: string | null
}

/**
 * One account's interest for a run.
 *
 * Per-item rather than on the total balance: an account with one invoice 90
 * days late and one issued yesterday must not be charged 90 days on both, and
 * charging on the balance does exactly that. Open-item data makes the correct
 * calculation possible, so it is the one used.
 *
 * `days` is the weighted average across the items — presentational only, so the
 * screen can say "R4 200 at 15.5% for about 47 days" without listing every
 * invoice. The charge itself is the sum of the per-item figures.
 */
export function calculateInterest(
  items: readonly OverdueItem[],
  terms: InterestTerms,
  opts: { minimumCharge?: number; interestAlreadyCharged?: number } = {},
): InterestCalculation {
  const empty: InterestCalculation = {
    base: 0, days: 0, ratePct: terms.ratePct, gross: 0,
    amount: 0, capped: false, skipReason: null,
  }

  if (!terms.enabled) return { ...empty, skipReason: 'Interest is not enabled on this account.' }
  if (terms.ratePct <= 0) return { ...empty, skipReason: 'No interest rate is set on this account.' }

  const chargeable = items.filter(
    (item) => item.outstanding > 0 && item.daysOverdue - Math.max(terms.graceDays, 0) > 0,
  )
  if (chargeable.length === 0) {
    return { ...empty, skipReason: 'Nothing is overdue past the grace period.' }
  }

  const base = chargeable.reduce((sum, item) => round(sum + item.outstanding, 2), 0)
  const gross = chargeable.reduce((sum, item) => round(sum + interestOn(item, terms), 2), 0)

  const weightedDays =
    base > 0
      ? Math.round(
          chargeable.reduce(
            (sum, item) =>
              sum + item.outstanding * (item.daysOverdue - Math.max(terms.graceDays, 0)),
            0,
          ) / base,
        )
      : 0

  const { amount: capped, capped: wasCapped } = capInDuplum(
    gross,
    base,
    opts.interestAlreadyCharged ?? 0,
  )

  const minimum = opts.minimumCharge ?? 0
  if (capped <= 0) {
    return {
      base, days: weightedDays, ratePct: terms.ratePct, gross, amount: 0, capped: wasCapped,
      skipReason: wasCapped
        ? 'Interest already charged has reached the capital outstanding (in duplum).'
        : 'The calculated interest is nil.',
    }
  }
  if (capped < minimum) {
    return {
      base, days: weightedDays, ratePct: terms.ratePct, gross, amount: 0, capped: wasCapped,
      skipReason: `Below the ${minimum.toFixed(2)} minimum charge.`,
    }
  }

  return {
    base, days: weightedDays, ratePct: terms.ratePct, gross,
    amount: capped, capped: wasCapped, skipReason: null,
  }
}

/**
 * The terms actually applied to an account: its own, or its group's.
 *
 * The account wins whenever it has anything set of its own, and `enabled` is
 * treated as the account's own decision rather than inherited when the account
 * has a rate. Opting one customer out of a group-wide charge must be possible
 * without removing the group's default.
 */
export function effectiveTerms(
  account: Partial<InterestTerms>,
  group: Partial<InterestTerms> | null,
): InterestTerms {
  const hasOwnRate = (account.ratePct ?? 0) > 0
  return {
    ratePct: hasOwnRate ? (account.ratePct ?? 0) : (group?.ratePct ?? 0),
    enabled: account.enabled ?? group?.enabled ?? false,
    graceDays: account.graceDays ?? group?.graceDays ?? 0,
  }
}

/* ── Settlement discount ─────────────────────────────────────────────────── */

export type DiscountTerms = {
  /** Pay within this many days of the invoice date to earn it. */
  days: number
  /** The percentage earned. */
  pct: number
}

export type DiscountOpportunity = {
  txnId: number
  docNumber: string | null
  docDate: string
  outstanding: number
  /** The last date the discount can still be earned. */
  deadline: string
  /** Days from the as-at date until the deadline. Negative once missed. */
  daysRemaining: number
  /** What paying by the deadline saves. */
  discount: number
  /** What would actually be paid. */
  netPayable: number
  expired: boolean
}

/**
 * The discount on one invoice, if paid on a given date.
 *
 * Zero once the window has passed. Deliberately NOT graduated: '2/10 net 30'
 * means two percent within ten days and nothing on day eleven, and softening
 * that cliff would quietly claim a discount the supplier has not agreed to and
 * will short-pay against.
 */
export function discountFor(
  invoiceDate: string,
  outstanding: number,
  terms: DiscountTerms,
  payOn: string,
): { discount: number; deadline: string; daysRemaining: number; expired: boolean } {
  const deadline = addDays(invoiceDate, Math.max(terms.days, 0))
  const daysRemaining = daysBetweenDates(payOn, deadline)
  const expired = daysRemaining < 0

  const earns = terms.days > 0 && terms.pct > 0 && !expired && outstanding > 0
  return {
    discount: earns ? round(outstanding * (terms.pct / 100), 2) : 0,
    deadline,
    daysRemaining,
    expired,
  }
}

/**
 * Everything that could still earn a discount, most urgent first.
 *
 * Ordering by deadline rather than by value is deliberate: the question this
 * answers is "what must I pay THIS WEEK to avoid losing a discount", and the
 * R80 saving expiring tomorrow is more actionable than the R400 expiring in
 * three weeks.
 */
export function discountOpportunities(
  invoices: readonly { txnId: number; docNumber: string | null; docDate: string; outstanding: number }[],
  terms: DiscountTerms,
  payOn: string,
): DiscountOpportunity[] {
  if (terms.days <= 0 || terms.pct <= 0) return []

  return invoices
    .map((invoice) => {
      const result = discountFor(invoice.docDate, invoice.outstanding, terms, payOn)
      return {
        txnId: invoice.txnId,
        docNumber: invoice.docNumber,
        docDate: invoice.docDate,
        outstanding: invoice.outstanding,
        deadline: result.deadline,
        daysRemaining: result.daysRemaining,
        discount: result.discount,
        netPayable: round(invoice.outstanding - result.discount, 2),
        expired: result.expired,
      }
    })
    .filter((o) => !o.expired && o.discount > 0)
    .sort((a, b) => a.daysRemaining - b.daysRemaining || b.discount - a.discount)
}

/**
 * Whether taking a settlement discount is worth paying early.
 *
 * '2/10 net 30' means giving up 20 days of money for 2%, which annualises to
 * roughly 37% — far above any overdraft rate, so it is almost always worth
 * taking. Almost, not always: a 0.5%/25-days-early term annualises to about
 * 7%, and a business paying 11% on its overdraft should decline that one.
 *
 * Returned as an annualised percentage so it can be compared directly against
 * the cost of the money used to pay early.
 */
export function annualisedDiscountRate(terms: DiscountTerms, normalTermsDays: number): number {
  const daysEarly = normalTermsDays - terms.days
  if (daysEarly <= 0 || terms.pct <= 0) return 0
  // The discount is earned on the NET amount paid, hence pct/(100-pct).
  return round((terms.pct / (100 - terms.pct)) * (DAYS_IN_YEAR / daysEarly) * 100, 2)
}

/* ── Dates ───────────────────────────────────────────────────────────────── */

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function daysBetweenDates(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}
