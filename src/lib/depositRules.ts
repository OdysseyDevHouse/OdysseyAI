import { round } from './decimals'

/**
 * What may be done with a deposit held against a sale, quote or invoice.
 *
 * Pure — no database, no `server-only` — so the till, the invoicing screen and
 * the posting engine all apply identical rules. Same split as `laybyRules.ts`
 * and `tenderMath.ts`, and for the same reason: a rule duplicated on the client
 * is a rule that will eventually disagree with the server, and the
 * disagreement shows up with a customer at the counter.
 *
 * ── THE MONEY IS STILL THEIRS ────────────────────────────────────────────
 *
 * A deposit is not a payment against a debt. Until the goods are handed over
 * the amount remains the property of the consumer — CPA s62(1)(a), the same
 * section that governs lay-bys, and the reason `laybyRules` refuses to keep a
 * cent it does not have to.
 *
 * Two consequences run through every function here:
 *
 *   1. A deposit is refundable in full, by default. Keeping any of it needs a
 *      reason the customer was told about beforehand.
 *   2. A deposit larger than the document total is refused rather than taken
 *      and refunded, because the shop would be holding money against nothing.
 *
 * ── WHAT THIS FILE DOES NOT DECIDE ───────────────────────────────────────
 *
 * Whether the drawer, the ledger or the VAT return sees the money. That is
 * `deposits.ts` on the server, and the answer is the drawer only. This module
 * decides amounts and refusals; it never decides postings.
 */

/** DECIMAL(12,4) dust. Two figures within this are the same figure. */
const EPSILON = 0.004

export type DepositPosition = {
  /** The document total, VAT inclusive. A deposit is measured against this. */
  totalIncl: number
  /** What is currently held — Σ amount over every row for the document. */
  heldTotal: number
}

/**
 * What is still to pay after the deposits already taken.
 *
 * Never negative. A deposit exceeding the total is refused at the point of
 * taking, so a negative here would mean the total was edited downward
 * afterwards — in which case the honest answer is that nothing is owed, and
 * the excess shows up in `refundable` instead.
 */
export function stillToPay(position: DepositPosition): number {
  return round(Math.max(position.totalIncl - position.heldTotal, 0), 2)
}

/**
 * How much of what is held would have to go back if the document were
 * abandoned right now.
 *
 * All of it. This is a named function rather than a bare property read because
 * "the refundable amount" is a legal question with a specific answer, and a
 * future change that makes it anything less should have to edit a function
 * whose docblock says why it currently does not.
 */
export function refundable(position: DepositPosition): number {
  return round(Math.max(position.heldTotal, 0), 2)
}

/**
 * The part of a held deposit that exceeds what the document is worth.
 *
 * Zero in the ordinary case. Non-zero only when lines were removed after the
 * deposit was taken, which is exactly when somebody needs telling.
 */
export function overheld(position: DepositPosition): number {
  return round(Math.max(position.heldTotal - position.totalIncl, 0), 2)
}

/** Whether the deposits already cover the document in full. */
export function isFullyCovered(position: DepositPosition): boolean {
  return stillToPay(position) <= EPSILON
}

/** How far through it is, for a progress bar. 0–100. */
export function percentHeld(position: DepositPosition): number {
  if (position.totalIncl <= 0) return 0
  return Math.min(round((position.heldTotal / position.totalIncl) * 100, 1), 100)
}

/** Document statuses a deposit may be taken against. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(['draft', 'saved', 'issued'])

export type TakeDepositInput = DepositPosition & {
  /** sales_documents.status. */
  status: string
  /** What the cashier keyed. */
  amount: number
  /** The store minimum, as a percentage of totalIncl. 0 disables it. */
  minPct?: number
  /** Whether a customer has been named on the document. */
  hasCustomer?: boolean
  /** Whether this store permits a deposit with no customer named. */
  allowWalkin?: boolean
}

/**
 * Why this deposit cannot be taken. Null means it can.
 *
 * Ordered so the most fundamental objection wins: there is no point telling
 * somebody their deposit is below the minimum when the document is already
 * finalised and cannot take one at all.
 *
 * Overpayment is refused rather than accepted-and-refunded, following
 * `laybyRules.paymentRefusal`. Taking more than the document is worth leaves
 * the shop holding money against nothing and the customer with no document
 * explaining it.
 */
export function takeRefusal(input: TakeDepositInput): string | null {
  if (input.status === 'finalised') {
    return 'This sale is already posted. Take the money as a payment against the invoice instead.'
  }
  if (input.status === 'cancelled') return 'This document was cancelled.'
  if (!OPEN_STATUSES.has(input.status)) {
    return 'A deposit can only be taken against an open document.'
  }

  if (!Number.isFinite(input.amount) || input.amount <= 0) return 'Enter an amount.'
  if (input.totalIncl <= 0) return 'Add something to the sale before taking a deposit.'

  if (input.hasCustomer === false && input.allowWalkin === false) {
    return 'Choose a customer before taking a deposit.'
  }

  const amount = round(input.amount, 2)
  const left = stillToPay(input)

  if (left <= EPSILON) {
    return 'The deposits already cover this in full.'
  }
  if (amount > left + EPSILON) {
    return `Only ${left.toFixed(2)} is left to pay. Take that and finish the sale.`
  }

  // The minimum is measured against the DOCUMENT, not against this payment, so
  // a second small deposit on top of a large first one is not refused.
  const minPct = input.minPct ?? 0
  if (minPct > 0) {
    const floor = round((input.totalIncl * minPct) / 100, 2)
    const wouldHold = round(input.heldTotal + amount, 2)
    if (wouldHold + EPSILON < floor) {
      return `This store asks for at least ${floor.toFixed(2)} (${minPct}%) up front.`
    }
  }

  return null
}

export type RefundDepositInput = DepositPosition & {
  status: string
  amount: number
}

/**
 * Why this refund cannot be given. Null means it can.
 *
 * Deliberately permissive: the money is the customer's, so the only refusals
 * are arithmetic ones and the one case where the deposit is no longer held
 * because the sale it belonged to has already consumed it.
 */
export function refundRefusal(input: RefundDepositInput): string | null {
  if (input.status === 'finalised') {
    return 'This sale is posted. Refund it through a credit note instead.'
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) return 'Enter an amount.'

  const held = refundable(input)
  if (held <= EPSILON) return 'There is no deposit held on this document.'

  if (round(input.amount, 2) > held + EPSILON) {
    return `Only ${held.toFixed(2)} is held. That is the most that can go back.`
  }
  return null
}

/**
 * What a deposit contributes when the document is finally posted.
 *
 * The whole of what is held, capped at the document total. The cap matters:
 * `overheld` money must not be turned into a tender, because a tender larger
 * than the sale would make the till hand back change for money that was taken
 * on a different day and already counted in a different cash-up.
 *
 * That excess is refunded as its own event, which is why it is excluded here
 * rather than netted off.
 */
export function tenderAtFinalise(position: DepositPosition): number {
  return round(Math.min(refundable(position), Math.max(position.totalIncl, 0)), 2)
}
