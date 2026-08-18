/**
 * One purchase line, and every figure derivable from it.
 *
 * Shared by the ordering screen and the receiving screen, because the
 * arithmetic is the same on both: an order is a statement of what a delivery
 * will cost, and a receipt is what it did cost. Two copies of this would drift
 * the first time a discount rule changed, and the drift would be silent —
 * an order that priced a line one way and a GRV that priced it another.
 *
 * Pure: no React, no database. That is what lets the test script check the
 * costing edge cases without rendering anything.
 *
 * ── THE ORDER OF OPERATIONS, WHICH IS THE WHOLE FILE ─────────────────────
 *
 *   1. gross      = qty x unit cost
 *   2. line discount   — percentage, or an absolute amount which wins
 *   3. document discount — apportioned across lines by value
 *   4. charges         — freight, apportioned by value
 *   5. landed cost     = (net + charges) / (qty + BONUS)
 *
 * Step 5 is the one that must not be got wrong. Bonus units increase what
 * arrives but not what is paid, so dividing by qty alone overstates the cost of
 * every promotional buy — and average_cost compounds that error with every
 * receipt. See docs/plans/purchasing-ordering-and-grv.md.
 *
 * Charges come AFTER the document discount because freight is not discounted by
 * the goods supplier's settlement terms: a 5% early-payment discount reduces
 * what is owed for the goods, not what the courier charged to deliver them.
 */

import { round } from '@/lib/decimals'
import { apportionDiscount } from '@/lib/documentMath'
import { addVat, removeVat, gpPercent, markupPercent } from '@/lib/pricing'

export type PurchaseLineValues = {
  /** What arrived, or what was ordered. Excludes bonus units. */
  qty: number
  /** Free units. Increase stock, contribute nothing to what is owed. */
  qtyBonus: number
  unitCostExcl: number
  discountPct: number
  /** Absolute discount. Wins over the percentage when non-zero. */
  discountAmount: number
  vatRatePct: number
}

export type PurchaseLineFigures = {
  /** qty x unit cost, before any discount. */
  grossExcl: number
  /** What came off this line — whichever of the two inputs applied. */
  discountExcl: number
  /** The effective percentage, for showing beside an absolute amount. */
  effectiveDiscountPct: number
  /** After the line's own discount. What the invoice line reads. */
  netExcl: number
  /** This line's share of the document discount. */
  documentDiscountExcl: number
  /** This line's share of freight and charges. */
  chargeExcl: number
  /** Net of both discounts, before charges. What VAT is charged on. */
  taxableExcl: number
  lineVat: number
  lineTotalIncl: number
  /** Total units entering stock — qty plus bonus. */
  qtyTotal: number
  /** Per unit, with charges in and bonus units sharing the cost. */
  landedCostExcl: number
  /** Unit cost with VAT, the figure a supplier invoice sometimes quotes. */
  unitCostIncl: number
}

/** The discount actually applied, absolute winning over percentage. */
export function lineDiscount(values: PurchaseLineValues): number {
  const gross = round(values.qty * values.unitCostExcl, 2)
  if (values.discountAmount > 0) return round(Math.min(values.discountAmount, gross), 2)
  return round(gross * (values.discountPct / 100), 2)
}

/**
 * Everything derivable from one line.
 *
 * `documentDiscountExcl` and `chargeExcl` are passed in rather than computed
 * here because both are apportioned across the whole document — a line cannot
 * know its own share. purchaseDocumentFigures() below does that and calls this.
 */
export function purchaseLineFigures(
  values: PurchaseLineValues,
  documentDiscountExcl = 0,
  chargeExcl = 0,
): PurchaseLineFigures {
  const grossExcl = round(values.qty * values.unitCostExcl, 2)
  const discountExcl = lineDiscount(values)
  const netExcl = round(grossExcl - discountExcl, 2)
  const taxableExcl = round(netExcl - documentDiscountExcl, 2)

  const lineVat = round(taxableExcl * (values.vatRatePct / 100), 2)
  const qtyTotal = round(values.qty + values.qtyBonus, 3)

  return {
    grossExcl,
    discountExcl,
    effectiveDiscountPct: grossExcl === 0 ? 0 : round((discountExcl / grossExcl) * 100, 3),
    netExcl,
    documentDiscountExcl,
    chargeExcl,
    taxableExcl,
    lineVat,
    lineTotalIncl: round(taxableExcl + lineVat, 2),
    qtyTotal,
    // Divides by qty INCLUDING bonus — see the header.
    landedCostExcl: qtyTotal === 0 ? 0 : round((taxableExcl + chargeExcl) / qtyTotal, 4),
    unitCostIncl: addVat(values.unitCostExcl, values.vatRatePct),
  }
}

export type PurchaseDocumentFigures = {
  lines: PurchaseLineFigures[]
  /** Sum of the lines after their own discounts, before the document one. */
  subtotalExcl: number
  /** The document discount actually applied, absolute winning over percentage. */
  discountExcl: number
  /** Sum of the lines after BOTH discounts. What VAT is charged on. */
  taxableExcl: number
  chargesExcl: number
  vatTotal: number
  totalIncl: number
}

/**
 * Every figure on a purchase document.
 *
 * The document discount and the charges are apportioned pro-rata by line value
 * using apportionDiscount(), which puts the rounding remainder on the largest
 * line — so a three-line R100 discount comes to exactly R100 rather than R99.99
 * depending on the order the lines happen to be in.
 *
 * Rule 3 of documentMath.ts is why this is apportioned at all rather than
 * subtracted from the total: a discount held only at document level cannot be
 * split by VAT rate, so a mixed-rate order would have an unallocatable VAT
 * figure.
 */
export function purchaseDocumentFigures(
  lines: readonly PurchaseLineValues[],
  options: {
    /** Percentage off the whole document. Ignored when the amount is given. */
    discountPct?: number
    /** Absolute discount on the whole document. Wins over the percentage. */
    discountExcl?: number
    /** Freight and the like, spread across the lines by value. */
    chargesExcl?: number
  } = {},
): PurchaseDocumentFigures {
  // Each line's own discount first — the document discount is apportioned by
  // what a line is actually worth, not by its list price.
  const netValues = lines.map((line) => {
    const gross = round(line.qty * line.unitCostExcl, 2)
    return round(gross - lineDiscount(line), 2)
  })
  const subtotalExcl = netValues.reduce((sum, value) => round(sum + value, 2), 0)

  const requested =
    (options.discountExcl ?? 0) > 0
      ? round(options.discountExcl ?? 0, 2)
      : round(subtotalExcl * ((options.discountPct ?? 0) / 100), 2)
  // Never more than the document is worth: a discount larger than the goods
  // would produce negative lines and a credit nobody asked for.
  const discountExcl = round(Math.min(Math.max(requested, 0), subtotalExcl), 2)

  const chargesExcl = round(Math.max(options.chargesExcl ?? 0, 0), 2)

  const discountShares = apportionDiscount(netValues, discountExcl)
  const chargeShares = apportionDiscount(netValues, chargesExcl)

  const figures = lines.map((line, index) =>
    purchaseLineFigures(line, discountShares[index], chargeShares[index]),
  )

  const taxableExcl = figures.reduce((sum, f) => round(sum + f.taxableExcl, 2), 0)
  const vatTotal = figures.reduce((sum, f) => round(sum + f.lineVat, 2), 0)

  return {
    lines: figures,
    subtotalExcl,
    discountExcl,
    taxableExcl,
    chargesExcl,
    vatTotal,
    // Charges are added at document level rather than inside the lines: they
    // are part of what is owed, but they are not part of what any one line was
    // invoiced at. The lines carry them only for costing.
    totalIncl: round(taxableExcl + chargesExcl + vatTotal, 2),
  }
}

/**
 * Margin for one line, against a selling price.
 *
 * Both sides exclusive of VAT — comparing an exclusive cost to an inclusive
 * price overstates margin by the VAT rate, which is the classic mistake this
 * codebase warns about in three separate places.
 *
 * Measured against LANDED cost, not invoice cost: the point of showing GP on a
 * receiving screen is to answer "does this delivery still make money", and
 * freight is part of what it cost to get there.
 */
export function purchaseLineMargin(
  landedCostExcl: number,
  sellIncl: number,
  sellingVatPct: number,
): { sellExcl: number; markup: number; gp: number; profit: number } {
  const sellExcl = removeVat(sellIncl, sellingVatPct)
  return {
    sellExcl,
    markup: markupPercent(landedCostExcl, sellExcl),
    gp: gpPercent(landedCostExcl, sellExcl),
    profit: round(sellExcl - landedCostExcl, 4),
  }
}

/**
 * The line total, run backwards into a unit cost.
 *
 * A buyer with a supplier invoice in hand often has the LINE total and not the
 * unit price: "ten of these, R120 the lot". Typing 120 into the line total and
 * having the cost come out at 12 is the same arithmetic the grid already does
 * forwards, so it lives beside it rather than inside a cell handler — and the
 * test script can then check the awkward cases without rendering a table.
 *
 * ── UNDOING THE STEPS IN REVERSE ──────────────────────────────────────────
 *
 * The figure on screen is `taxableExcl`: gross, less the line's own discount,
 * less this line's share of the DOCUMENT discount. So the target is walked back
 * up through both before it is divided by the quantity:
 *
 *   1. add the document-discount share back  — it was subtracted flat
 *   2. undo the line discount                — see the two cases below
 *   3. divide by qty                         — NOT qty + bonus
 *
 * Step 2 has two shapes because the two discount inputs are different kinds of
 * claim. An ABSOLUTE amount is a rand figure the supplier put on the invoice;
 * it does not move when the cost does, so it is simply added back. A PERCENTAGE
 * is a proportion of the gross, so the gross that yields the target is
 * `target / (1 - pct/100)` — adding a percentage of the *target* back would
 * land short, and the line would settle at the wrong figure while looking
 * arithmetically plausible.
 *
 * Step 3 divides by qty alone, unlike landedCostExcl which divides by qty plus
 * bonus. That is not an inconsistency: bonus units are free, so they are not
 * part of what the line total is paying for. Dividing the target across them
 * would silently inflate the unit cost on every promotional buy — the same trap
 * landedCostExcl exists to avoid, arrived at from the other direction.
 *
 * Returns null when the answer would be meaningless — no quantity to divide by,
 * a discount of 100%, or a target that cannot be reached without a negative
 * cost. The caller leaves the line alone rather than writing NaN into it.
 */
export function unitCostFromLineTotal(
  values: PurchaseLineValues,
  /** What the line should come to, excluding VAT and after every discount. */
  targetExcl: number,
  /** This line's share of the document discount, as the grid renders it. */
  documentDiscountExcl = 0,
): number | null {
  if (!Number.isFinite(targetExcl) || targetExcl < 0) return null
  if (values.qty <= 0) return null

  // 1. The document discount came off flat, so it goes back on flat.
  const netExcl = round(targetExcl + documentDiscountExcl, 2)

  // 2. Undo whichever discount is in force — absolute wins, exactly as it does
  //    in lineDiscount() going the other way.
  let grossExcl: number
  if (values.discountAmount > 0) {
    grossExcl = round(netExcl + values.discountAmount, 2)
  } else if (values.discountPct > 0) {
    if (values.discountPct >= 100) return null
    grossExcl = round(netExcl / (1 - values.discountPct / 100), 2)
  } else {
    grossExcl = netExcl
  }

  if (grossExcl < 0) return null

  // 3. Across the units actually paid for. Four places, matching landedCostExcl
  //    — a unit cost is not a money figure, it is the input to one.
  return round(grossExcl / values.qty, 4)
}

/**
 * The same, from a line total that INCLUDES VAT.
 *
 * A supplier invoice quotes one or the other depending on the supplier, and the
 * grid offers both boxes for that reason. This only strips the VAT and hands
 * over: keeping one inversion means a change to the discount rules cannot fix
 * the exclusive box and leave the inclusive one wrong.
 */
export function unitCostFromLineTotalIncl(
  values: PurchaseLineValues,
  targetIncl: number,
  documentDiscountExcl = 0,
): number | null {
  if (!Number.isFinite(targetIncl) || targetIncl < 0) return null
  return unitCostFromLineTotal(
    values,
    removeVat(targetIncl, values.vatRatePct),
    documentDiscountExcl,
  )
}
