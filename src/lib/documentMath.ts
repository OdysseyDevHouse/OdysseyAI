import { round } from './decimals'

/**
 * The ONLY place a document figure is computed.
 *
 * Sales today, purchasing later — the arithmetic is identical whether you are
 * buying or selling, which is why this is documentMath and not salesMath.
 *
 * Pure: no database, no siteId, no imports beyond rounding. That is deliberate.
 * This is where an invoicing module goes wrong, the failure is silent, and it
 * is the one file in the project that can be exhaustively tested without a
 * connection.
 *
 * ── THE RULES ────────────────────────────────────────────────────────────
 *
 * 1. THE LINE IS THE ONLY ROUNDING BOUNDARY.
 *    Each line's inclusive total is rounded to 2dp once. The document total is
 *    the SUM of already-rounded lines — never round2(sum of unrounded). Pick
 *    the line as the boundary and the classic sum-of-rounded ≠ rounded-sum
 *    discrepancy has nowhere to occur.
 *
 * 2. VAT IS DERIVED BY SUBTRACTION.
 *      excl = round2(incl / (1 + r))
 *      vat  = incl - excl          ← subtraction, NOT round2(incl * r/(1+r))
 *    Subtraction is exact by construction: excl + vat is incl for every amount
 *    at every rate, because vat is DEFINED as the remainder. Computing VAT
 *    independently is not, and when the two round apart the document stops
 *    balancing and the VAT return does not tie back.
 *
 *    Measured over 200 000 amounts: at 15% the two happen to agree, but at 20%
 *    they diverge one time in SEVEN. So the rule is not "15% is safe" — it is
 *    that only subtraction is safe at any rate, and a rate change must never be
 *    the thing that breaks invoicing.
 *
 * 3. A DOCUMENT-LEVEL DISCOUNT IS APPORTIONED ONTO THE LINES first, never
 *    applied to the total. A discount that exists only at document level cannot
 *    be split by VAT rate, so a mixed-rate basket would have an unallocatable
 *    VAT figure.
 *
 * 4. CASH ROUNDING APPLIES TO THE TENDER, NOT THE INVOICE. See roundToCash.
 */

export type LineInput = {
  qty: number
  /** VAT-INCLUSIVE. The figure on the shelf and the one the customer agreed to. */
  unitPriceIncl: number
  /** Percentage off. Ignored when discountIncl is given. */
  discountPct?: number
  /** An absolute discount, which wins over the percentage when both are given. */
  discountIncl?: number
  vatRatePct: number
}

export type LineTotals = {
  /** Before discount, for showing what was taken off. */
  grossIncl: number
  discountIncl: number
  lineTotalIncl: number
  lineTotalExcl: number
  lineVat: number
}

/**
 * One line's figures.
 *
 * Everything derives from the inclusive total, in this order: gross, then
 * discount, then the rounded inclusive line, then the split. Reordering these
 * changes the answer by a cent on some inputs.
 */
export function lineTotals(input: LineInput): LineTotals {
  const grossIncl = round(input.qty * input.unitPriceIncl, 2)

  const discountIncl =
    input.discountIncl !== undefined
      ? round(input.discountIncl, 2)
      : round(grossIncl * ((input.discountPct ?? 0) / 100), 2)

  const lineTotalIncl = round(grossIncl - discountIncl, 2)
  const { excl, vat } = splitIncl(lineTotalIncl, input.vatRatePct)

  return { grossIncl, discountIncl, lineTotalIncl, lineTotalExcl: excl, lineVat: vat }
}

/**
 * Splits a VAT-inclusive figure. Rule 2 — the whole trick is the subtraction.
 *
 * Handles a negative amount unchanged, which is what a credit note line needs:
 * −115 at 15% must split to −100 and −15, not to 100 and 15.
 */
export function splitIncl(amountIncl: number, vatRatePct: number): { excl: number; vat: number } {
  const incl = round(amountIncl, 2)
  if (vatRatePct <= 0) return { excl: incl, vat: 0 }

  const excl = round(incl / (1 + vatRatePct / 100), 2)
  return { excl, vat: round(incl - excl, 2) }
}

export type DocumentTotals = {
  subtotalExcl: number
  vatTotal: number
  discountTotal: number
  totalIncl: number
  /** VAT split per rate, for the tax invoice and the VAT return. */
  vatByRate: { ratePct: number; excl: number; vat: number; incl: number }[]
}

/**
 * Document totals from already-computed lines.
 *
 * Every figure is a sum of 2dp values, so the result is exact and
 * `subtotalExcl + vatTotal === totalIncl` holds identically. assertBalanced()
 * checks that at finalise; if it ever fails, something bypassed this file.
 */
export function documentTotals(lines: readonly (LineTotals & { vatRatePct: number })[]): DocumentTotals {
  let subtotalExcl = 0
  let vatTotal = 0
  let discountTotal = 0
  let totalIncl = 0

  // A tax invoice covering more than one rate must print the VAT per rate.
  const byRate = new Map<number, { ratePct: number; excl: number; vat: number; incl: number }>()

  for (const line of lines) {
    subtotalExcl = round(subtotalExcl + line.lineTotalExcl, 2)
    vatTotal = round(vatTotal + line.lineVat, 2)
    discountTotal = round(discountTotal + line.discountIncl, 2)
    totalIncl = round(totalIncl + line.lineTotalIncl, 2)

    const entry = byRate.get(line.vatRatePct) ?? {
      ratePct: line.vatRatePct,
      excl: 0,
      vat: 0,
      incl: 0,
    }
    entry.excl = round(entry.excl + line.lineTotalExcl, 2)
    entry.vat = round(entry.vat + line.lineVat, 2)
    entry.incl = round(entry.incl + line.lineTotalIncl, 2)
    byRate.set(line.vatRatePct, entry)
  }

  return {
    subtotalExcl,
    vatTotal,
    discountTotal,
    totalIncl,
    vatByRate: [...byRate.values()].sort((a, b) => b.ratePct - a.ratePct),
  }
}

/**
 * Spreads a document-level discount across the lines, pro-rata by value.
 *
 * Rule 3. The rounding remainder goes onto the LARGEST line, so the apportioned
 * amounts always sum to exactly the discount asked for — putting it on the
 * first line would make a 3-line R100 discount come to R99.99 or R100.01
 * depending on the order the lines happen to be in.
 *
 * Returns the per-line discount to add to whatever line discount already
 * exists.
 */
export function apportionDiscount(
  lineTotals: readonly number[],
  discountIncl: number,
): number[] {
  const total = round(
    lineTotals.reduce((sum, value) => sum + value, 0),
    2,
  )
  const discount = round(discountIncl, 2)

  if (discount === 0 || total === 0) return lineTotals.map(() => 0)

  const shares = lineTotals.map((value) => round((value / total) * discount, 2))
  const allocated = round(
    shares.reduce((sum, value) => sum + value, 0),
    2,
  )
  const remainder = round(discount - allocated, 2)

  if (remainder !== 0) {
    let largest = 0
    for (let i = 1; i < lineTotals.length; i++) {
      if (Math.abs(lineTotals[i]) > Math.abs(lineTotals[largest])) largest = i
    }
    shares[largest] = round(shares[largest] + remainder, 2)
  }

  return shares
}

/**
 * Rounds a payable amount to the nearest cash denomination.
 *
 * Rule 4, and the classic South African POS bug. This applies to the TENDER,
 * never to the invoice: the invoice says R432.47, the drawer takes R432.45, and
 * the difference is recorded as rounding_adj. Rounding the invoice instead
 * would make the VAT declared on every cash sale wrong by a couple of cents,
 * which compounds into a real reconciliation problem over a year.
 *
 * Returns both figures so the caller stores the adjustment rather than losing
 * it.
 */
export function roundToCash(
  amount: number,
  denomination: number,
): { rounded: number; adjustment: number } {
  if (denomination <= 0) return { rounded: round(amount, 2), adjustment: 0 }

  const value = round(amount, 2)
  const rounded = round(Math.round(value / denomination) * denomination, 2)
  return { rounded, adjustment: round(rounded - value, 2) }
}

/**
 * The invariant, checked at finalise.
 *
 * If this ever fails, something computed a figure outside this file. Throwing
 * is correct: a document whose parts do not add up must not be posted, and the
 * whole posting runs inside a transaction that will roll back.
 */
export function assertBalanced(totals: DocumentTotals): void {
  const sum = round(totals.subtotalExcl + totals.vatTotal, 2)
  if (sum !== round(totals.totalIncl, 2)) {
    throw new Error(
      `Document does not balance: excl ${totals.subtotalExcl} + VAT ${totals.vatTotal} = ${sum}, but total is ${totals.totalIncl}. Something computed a figure outside documentMath.`,
    )
  }
}

/**
 * The new weighted average cost after receiving stock.
 *
 *   new average = (existing value + received value) / (existing qty + received qty)
 *
 * All figures EXCLUSIVE of VAT — mixing an inclusive cost in here would inflate
 * stock valuation by the VAT rate, and the error compounds with every receipt.
 *
 * ── THE EDGE CASES, which are where this goes wrong ─────────────────────
 *
 * NEGATIVE OR ZERO resulting quantity: the average is meaningless (there is
 * nothing to average over), so the last cost stands rather than a divide by
 * zero or a nonsense figure.
 *
 * NEGATIVE EXISTING STOCK — a real situation, when goods are sold before the
 * paperwork arrives. Blending against a negative quantity produces an average
 * that can be negative or wildly wrong, so the received cost simply takes over.
 * A stock figure that was already impossible cannot be made more accurate by
 * averaging into it.
 */
export function weightedAverageCost(input: {
  /** Quantity on hand BEFORE the receipt. May be negative. */
  existingQty: number
  /** Current average cost, exclusive of VAT. */
  existingCostExcl: number
  receivedQty: number
  /** Cost of what is being received, exclusive of VAT, per unit. */
  receivedCostExcl: number
}): number {
  const existingQty = round(input.existingQty, 3)
  const receivedQty = round(input.receivedQty, 3)
  const totalQty = round(existingQty + receivedQty, 3)

  // Nothing received: the average cannot have moved.
  if (receivedQty === 0) return round(input.existingCostExcl, 4)

  // Negative or zero stock before the receipt — see the note above.
  if (existingQty <= 0) return round(input.receivedCostExcl, 4)

  // Everything cancelled out, so there is nothing left to hold a cost.
  if (totalQty <= 0) return round(input.receivedCostExcl, 4)

  const existingValue = existingQty * input.existingCostExcl
  const receivedValue = receivedQty * input.receivedCostExcl

  // 4 places, matching the DECIMAL(12,4) column: a unit cost has to survive
  // division without drifting — a case of 24 at 199.99 is 8.3329 each.
  return round((existingValue + receivedValue) / totalQty, 4)
}

/**
 * Margin on a line, for the GP report.
 *
 * Cost is exclusive of VAT and so is the selling figure it is compared against
 * — comparing an exclusive cost to an inclusive price overstates margin by the
 * VAT rate, which is the other classic mistake.
 */
export function lineMargin(
  lineTotalExcl: number,
  unitCostExcl: number,
  qty: number,
): { costExcl: number; profit: number; gpPct: number } {
  const costExcl = round(unitCostExcl * qty, 2)
  const profit = round(lineTotalExcl - costExcl, 2)
  // GP is profit over SELLING price; markup is profit over cost. They are
  // different ratios of the same two numbers and are routinely confused.
  const gpPct = lineTotalExcl === 0 ? 0 : round((profit / lineTotalExcl) * 100, 2)
  return { costExcl, profit, gpPct }
}
