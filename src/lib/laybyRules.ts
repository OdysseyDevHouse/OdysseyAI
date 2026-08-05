import { round } from './decimals'

/**
 * What the law allows a shop to do with a lay-by.
 *
 * Pure — no database, no `server-only` — so the till, the lay-by screen and
 * the posting engine all apply identical rules. Same split as
 * `documentMath.ts` and `creditRules.ts`, and for the same reason: a rule
 * duplicated on the client is a rule that will eventually disagree with the
 * server, and the disagreement shows up with a customer at the counter.
 *
 * ── THE SOURCE ───────────────────────────────────────────────────────────
 *
 * Section 62 of the Consumer Protection Act 68 of 2008, read verbatim. What
 * the Act actually says, subsection by subsection:
 *
 *   62(1)(a)  each amount paid "remains the property of the consumer …
 *             until the goods have been delivered"
 *   62(1)(b)  the goods "remain at the risk of the supplier" until delivery
 *   62(2)     if the supplier cannot deliver once fully paid: equivalent or
 *             superior goods, OR the money back with interest where the cause
 *             was beyond their control, OR **double** the amount paid where
 *             it was not
 *   62(3)     a stock shortage caused by the supplier failing to "adequately
 *             and diligently carry out any ordinary or routine matter" is
 *             expressly NOT beyond their control — so it is the double
 *             remedy
 *   62(4)     a termination penalty is only possible once the consumer is
 *             **60 business days** past the anticipated completion date, and
 *             everything else must be refunded after deducting it
 *   62(5)(a)  no penalty where the failure to pay was due to the consumer's
 *             death or hospitalisation
 *   62(5)(b)  no penalty unless the supplier "informed the consumer of the
 *             fact and extent of the penalty BEFORE the consumer entered
 *             into the lay-by agreement"
 *   62(6)     "The Minister MAY prescribe a basis for calculating the maximum
 *             amount of a cancellation penalty"
 *
 * ── THE CAP IS NOT STATUTORY ─────────────────────────────────────────────
 *
 * 62(6) is an enabling provision, not a limit: it lets the Minister set a
 * maximum, and no such regulation is reflected in the Act text. The widely
 * repeated "1%" is guidance rather than law.
 *
 * So the ceiling below is a DEFAULT STORE POLICY, deliberately conservative,
 * and it is overridable. The three things that ARE law — the 60 business
 * days, the death/hospitalisation exemption and the disclosure requirement —
 * are refusals in this file and cannot be configured away.
 */

/**
 * The default ceiling on a cancellation penalty, as a percentage of the full
 * price.
 *
 * A house rule, not a statute. 62(6) lets the Minister prescribe a maximum and
 * none appears in the Act; 1% is the figure commonly cited in trade guidance
 * and is a defensible, conservative default. A store with legal advice to the
 * contrary can raise it — see `layby_max_fee_pct` in settings.
 */
export const DEFAULT_MAX_CANCELLATION_FEE_PCT = 1

/** Business days past the due date before any fee may be charged. */
export const PENALTY_GRACE_BUSINESS_DAYS = 60

/**
 * Reasons a fee must be waived even when it would otherwise apply.
 *
 * Death and hospitalisation are named in the Act. "Not disclosed" is the
 * fourth condition — a fee the customer was never told about is not
 * chargeable regardless of circumstance.
 */
export const FEE_WAIVER_REASONS = [
  'death',
  'hospitalisation',
  'not_disclosed',
  'store_decision',
] as const
export type FeeWaiverReason = (typeof FEE_WAIVER_REASONS)[number]

export const FEE_WAIVER_LABELS: Record<FeeWaiverReason, string> = {
  death: 'Customer died',
  hospitalisation: 'Customer was hospitalised',
  not_disclosed: 'The fee was not disclosed up front',
  store_decision: 'Waived by the store',
}

/** Statutory waivers — the shop has no discretion about these. */
const STATUTORY_WAIVERS: ReadonlySet<string> = new Set(['death', 'hospitalisation', 'not_disclosed'])

export function isStatutoryWaiver(reason: string | null | undefined): boolean {
  return STATUTORY_WAIVERS.has(String(reason ?? ''))
}

/**
 * Clamps a configured fee percentage to the store's ceiling.
 *
 * Returns the figure to use AND whether it had to be reduced, so a setup
 * screen can say so instead of silently saving something different from what
 * was typed.
 *
 * `max` defaults to the house rule. It is a parameter because 62(6) leaves the
 * maximum to regulation rather than fixing it in the Act — if one is
 * prescribed, or a store has advice supporting a different figure, this is the
 * single place it changes.
 */
export function clampFeePct(
  pct: number,
  max: number = DEFAULT_MAX_CANCELLATION_FEE_PCT,
): { pct: number; clamped: boolean } {
  const ceiling = Number.isFinite(max) && max >= 0 ? max : DEFAULT_MAX_CANCELLATION_FEE_PCT
  if (!Number.isFinite(pct) || pct <= 0) return { pct: 0, clamped: false }
  if (pct > ceiling) return { pct: round(ceiling, 3), clamped: true }
  return { pct: round(pct, 3), clamped: false }
}

/**
 * Business days between two dates, excluding weekends.
 *
 * Public holidays are NOT excluded, which makes this slightly generous to the
 * customer — the grace period runs a few days shorter than the Act strictly
 * allows. That is the safe direction to be wrong in: charging a fee a day too
 * early is a breach, waiting a day too long is a kindness.
 */
export function businessDaysBetween(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0
  if (end <= start) return 0

  let days = 0
  const cursor = new Date(start)
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1)
    const day = cursor.getDay()
    if (day !== 0 && day !== 6) days += 1
  }
  return days
}

export type CancellationInput = {
  /** The agreed total, VAT inclusive. The fee is a percentage of THIS. */
  totalIncl: number
  /** What the customer has actually handed over. */
  paidTotal: number
  /** The agreed completion date. Null means no fee can ever apply. */
  dueDate: string | null
  /** Today, or the date the cancellation is being processed. */
  asAt: string
  /** The store's disclosed fee percentage. */
  feePct: number
  /** Set when the fee must be waived. */
  waiverReason?: FeeWaiverReason | null
}

export type CancellationOutcome = {
  /** What the shop may keep. Never more than 1% of the total, never more than paid. */
  fee: number
  /** What must go back to the customer. */
  refund: number
  /** The percentage actually applied, for the record. */
  appliedPct: number
  /** Why no fee was charged, when none was. */
  noFeeReason: string | null
  /** How far past due they are, for the screen to show. */
  businessDaysOverdue: number
}

/**
 * What happens when a lay-by is cancelled.
 *
 * The default is a FULL refund. A fee is the exception, and every condition
 * below has to be satisfied before a cent is kept:
 *
 *   the store has disclosed a fee · the due date has passed · sixty business
 *   days have elapsed since · no statutory waiver applies
 *
 * Anything else refunds everything. That is both the law and the right
 * default — the money was never the shop's.
 */
export function cancellationOutcome(input: CancellationInput): CancellationOutcome {
  const paid = round(Math.max(input.paidTotal, 0), 2)
  const overdue = input.dueDate ? businessDaysBetween(input.dueDate, input.asAt) : 0

  const full = (reason: string | null): CancellationOutcome => ({
    fee: 0,
    refund: paid,
    appliedPct: 0,
    noFeeReason: reason,
    businessDaysOverdue: overdue,
  })

  if (input.waiverReason) {
    return full(FEE_WAIVER_LABELS[input.waiverReason] ?? 'Fee waived')
  }

  const { pct } = clampFeePct(input.feePct)
  if (pct <= 0) return full('No cancellation fee is charged by this store.')
  if (!input.dueDate) return full('No completion date was agreed, so no fee can apply.')

  if (overdue < PENALTY_GRACE_BUSINESS_DAYS) {
    return full(
      `A fee may only be charged ${PENALTY_GRACE_BUSINESS_DAYS} business days after the due date — this one is ${overdue}.`,
    )
  }

  // 1% of the FULL price, not of what was paid. But never more than the
  // customer actually handed over: the shop cannot end up owed money by
  // someone cancelling.
  const raw = round((input.totalIncl * pct) / 100, 2)
  const fee = round(Math.min(raw, paid), 2)

  return {
    fee,
    refund: round(paid - fee, 2),
    appliedPct: pct,
    noFeeReason: null,
    businessDaysOverdue: overdue,
  }
}

export type LaybyPosition = {
  totalIncl: number
  paidTotal: number
}

/** What is still owed before the goods can be handed over. Never negative. */
export function outstanding(layby: LaybyPosition): number {
  return round(Math.max(layby.totalIncl - layby.paidTotal, 0), 2)
}

/** Whether the final payment has been made and the goods may be released. */
export function isSettled(layby: LaybyPosition): boolean {
  return outstanding(layby) <= 0.004
}

/** How far through it is, for a progress bar. 0–100. */
export function percentPaid(layby: LaybyPosition): number {
  if (layby.totalIncl <= 0) return 0
  return Math.min(round((layby.paidTotal / layby.totalIncl) * 100, 1), 100)
}

/**
 * Why this payment cannot be taken. Null means it can.
 *
 * Overpayment is refused rather than accepted-and-refunded: taking more than
 * is owed would leave the shop holding money against a lay-by that no longer
 * exists, and the customer with no document explaining it.
 */
export function paymentRefusal(
  layby: LaybyPosition & { status: string },
  amount: number,
): string | null {
  if (layby.status === 'completed') return 'This lay-by is already paid up.'
  if (layby.status === 'cancelled') return 'This lay-by was cancelled.'
  if (layby.status === 'expired') return 'This lay-by has expired.'
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter an amount.'

  const left = outstanding(layby)
  if (round(amount, 2) > left + 0.004) {
    return `Only ${left.toFixed(2)} is outstanding. Take that and hand the goods over.`
  }
  return null
}
