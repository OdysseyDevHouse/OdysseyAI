import { round } from './decimals'

/**
 * What a till should OFFER at the tender pad — as opposed to what the posting
 * engine will allow, which is `tenderMath.checkTenders` and is the real gate.
 *
 * Pure, and no `server-only`: both tender pads run this in the browser, and a
 * test exercises it with no database. Extracted from the desk till's TenderPad
 * when the touch till gained its own, because two copies of "how much cash would
 * a cashier plausibly be handed" is two places for the note denominations to
 * drift apart.
 *
 * ── THE DISTINCTION THAT MATTERS ──────────────────────────────────────────
 *
 * Nothing here is a permission. A ceiling computed from a loyalty balance the
 * client was handed is a convenience so the pad does not offer an amount the
 * server is about to refuse; the server re-reads that balance under a lock at
 * finalise. Treating any of this as authoritative is how a client-side figure
 * becomes money.
 */

/**
 * The two fields that identify a loyalty tender.
 *
 * Structural rather than importing TenderType, which is `server-only` — and
 * narrower than TenderBehaviour, which carries neither of these because the
 * posting engine's arithmetic does not care WHICH balance a tender spends, only
 * how it behaves.
 */
export type LoyaltyIdentity = {
  integrationKey: string | null
  code: string
}

/** What a loyalty tender is worth as the till currently understands it. */
export type LoyaltyOffer = {
  /** The most points may settle on this sale, already capped by the minimum. */
  maxRedeemable: number
  walletBalance: number
}

/**
 * The cash amounts worth putting on buttons for an owed figure.
 *
 * Always includes the exact amount, then the next round note up. The point is
 * that a cashier handed a R200 note on an R87.50 sale taps once rather than
 * typing 200 — and the change is then computed rather than done in their head at
 * a counter with a queue.
 *
 * Capped at five: a row of eight buttons takes longer to read than the keypad
 * takes to type.
 */
export function quickAmounts(owed: number, limit = 5): number[] {
  if (owed <= 0) return []
  const notes = [20, 50, 100, 200, 500]
  const options = new Set<number>([round(owed, 2)])

  for (const note of notes) {
    const rounded = Math.ceil(owed / note) * note
    if (rounded >= owed) options.add(rounded)
  }

  // Ascending, and the exact amount is always the first — so trimming drops the
  // LARGEST notes, which are the least likely to be handed over on a small sale.
  return [...options].sort((a, b) => a - b).slice(0, limit)
}

/**
 * The most this tender may take, or null when it is not capped by a balance.
 *
 * Null and zero mean different things and the difference is load-bearing: null is
 * "cash, take what you like", zero is "a loyalty tender against a customer with
 * nothing in it", which must be offered as unavailable rather than as unlimited.
 */
export function loyaltyCeiling(
  tender: LoyaltyIdentity,
  loyalty: LoyaltyOffer | null,
): number | null {
  if (tender.integrationKey !== 'loyalty') return null
  if (!loyalty) return 0
  if (tender.code === 'LOYALTY_POINTS') return loyalty.maxRedeemable
  if (tender.code === 'LOYALTY_WALLET') return loyalty.walletBalance
  return null
}

/**
 * What to pre-fill when a tender key is tapped.
 *
 * The whole outstanding amount, because one tender for the whole sale is the
 * overwhelmingly common case and re-typing the total is wasted keystrokes. A
 * loyalty tender offers the smaller of what is owed and what the customer holds,
 * so the pad never proposes an amount the server is going to refuse.
 */
export function prefillAmount(
  tender: LoyaltyIdentity,
  owed: number,
  loyalty: LoyaltyOffer | null,
): number {
  const ceiling = loyaltyCeiling(tender, loyalty)
  return Math.max(ceiling === null ? owed : Math.min(owed, ceiling), 0)
}
