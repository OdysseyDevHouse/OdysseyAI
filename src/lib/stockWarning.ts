/**
 * Is the shop about to sell more than it has?
 *
 * Pure, so the till and a test can both run it and the answer cannot depend on
 * where it was asked. No database, no React, no server-only import — the same
 * shape as tenderMath and documentMath, and for the same reason: a rule that can
 * only be exercised through a screen is a rule nobody exercises.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * It does not refuse. It reports, and the caller decides — because a shop that
 * has sold something it cannot immediately hand over usually knows what it is
 * doing: the customer is collecting tomorrow, the delivery is in the yard, the
 * count is out and everybody knows it. A till that blocked the sale would be
 * arguing with a cashier who has more information than it does.
 *
 * It also does not look at RESERVED stock. An order or a lay-by holds units off
 * the shelf, and a counter sale of the same product should say so — but
 * `availableQty` already carries that subtraction, and which of the two figures
 * to pass is the caller's decision rather than this function's.
 */

/** One line, reduced to what the question needs. */
export type StockLine = {
  productId: number | null
  description: string
  /** How many this basket wants. */
  qty: number
  /**
   * What the shop has, as the till last saw it.
   *
   * Null means the till does not know — a non-stock line, a product deleted since
   * it was rung up, or a catalogue that never carried the figure. Unknown is NOT
   * a shortage: warning about it would fire on every service, deposit and
   * delivery line in the shop.
   */
  onHand: number | null
  /**
   * Whether this product is stock-tracked at all.
   *
   * A service, a gift card or a deposit has no shelf to run out of. Passing
   * false is what keeps those silent regardless of the figures on them.
   */
  tracked: boolean
}

export type StockShortfall = {
  productId: number | null
  description: string
  /** What the basket wants. */
  wanted: number
  /** What the shop has. Can be negative where a count has already gone wrong. */
  onHand: number
  /** How many are missing — always positive. */
  short: number
}

/**
 * The lines this basket cannot cover, worst shortfall first.
 *
 * Empty means nothing to say, which is the answer the caller wants most of the
 * time and the one it should be cheapest to act on.
 *
 * ── THE SAME PRODUCT ON TWO LINES ─────────────────────────────────────────
 *
 * Summed before comparing. A basket with 3 of something on one line and 2 on
 * another wants 5, and checking each line alone would clear both against an
 * on-hand of 4 while the sale as a whole is one short. That is not a rare
 * shape: it is what a scanner produces when a cashier scans the same item at
 * two different moments, and what a line-level check would silently miss.
 */
export function stockShortfalls(lines: readonly StockLine[]): StockShortfall[] {
  const wanted = new Map<number, { description: string; qty: number; onHand: number }>()

  for (const line of lines) {
    if (!line.tracked) continue
    if (line.productId === null) continue
    if (line.onHand === null || !Number.isFinite(line.onHand)) continue
    /* A return line is negative and PUTS STOCK BACK, so it can never cause a
       shortage — and letting it net against a sale line for the same product
       would hide one. Ignored rather than subtracted. */
    if (!(line.qty > 0)) continue

    const seen = wanted.get(line.productId)
    if (seen) {
      seen.qty += line.qty
    } else {
      wanted.set(line.productId, {
        description: line.description,
        qty: line.qty,
        /* The FIRST line's figure wins. Every line for one product reports the
           same on-hand, so a later one disagreeing means the catalogue was
           refreshed mid-basket — and the number the cashier has been looking at
           is the one to hold them to. */
        onHand: line.onHand,
      })
    }
  }

  const short: StockShortfall[] = []
  for (const [productId, entry] of wanted) {
    if (entry.qty <= entry.onHand) continue
    short.push({
      productId,
      description: entry.description,
      wanted: entry.qty,
      onHand: entry.onHand,
      short: entry.qty - entry.onHand,
    })
  }

  /* Worst first: a cashier reading a list under a customer's eyes reads the top
     of it, so the biggest problem has to be there. */
  return short.sort((a, b) => b.short - a.short)
}

/**
 * The warning, in words a cashier can act on at the pad.
 *
 * Names the product when there is one problem and counts them when there are
 * several — "3 items are short" with no names is a message that sends somebody
 * back through the basket line by line.
 *
 * Returns null when there is nothing to say, so the caller can use the result
 * as the condition itself rather than checking a length separately.
 */
export function stockWarning(shortfalls: readonly StockShortfall[]): string | null {
  if (shortfalls.length === 0) return null

  const first = shortfalls[0]
  if (shortfalls.length === 1) {
    return `${first.description}: selling ${first.wanted} but only ${first.onHand} on hand.`
  }
  return `${first.description} and ${shortfalls.length - 1} other item${
    shortfalls.length === 2 ? '' : 's'
  } are short on stock.`
}
