import { round } from './decimals'
import type { TillProduct } from './site/tillSearch'

/**
 * A basket, and the pure functions that change one.
 *
 * ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────
 *
 * `BasketLine` was declared inside sales/new/TillScreen.tsx and exported from
 * there. That was fine while one screen owned a basket; with two tills it is how
 * they silently diverge — a fix to how a discount ceiling is enforced, or to when
 * two scans merge into one line, lands in one and not the other, and nobody finds
 * out until a shop asks why the same product behaves differently on till 2.
 *
 * So the SHAPE and the RULES live here, once. Both screens import them.
 *
 * ── PURE, AND NO `server-only` ────────────────────────────────────────────
 *
 * Every function here is a plain value-in value-out transform: no React, no
 * fetch, no database. That is what lets the till run them offline in the browser,
 * lets a test exercise them with no database at all, and lets the reducer in the
 * POS be a switch statement over them rather than a pile of setState calls.
 *
 * Pricing arithmetic is NOT here — that is documentMath/tenderMath/specialsEngine,
 * which are already shared and already pure. This module only decides what is in
 * the basket.
 */

export type BasketLine = {
  /** Stable within the basket only — the database line id does not exist yet. */
  key: string
  productId: number | null
  productCode: string | null
  description: string
  productType: TillProduct['productType']
  departmentId: number | null
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  unitCostExcl: number
  maxDiscountPct: number
  /**
   * The structure price, so a line modal can tell an override from the shelf
   * figure. Null when the product is priced at the counter, where there is no
   * shelf figure to differ from.
   */
  shelfPriceIncl: number | null
  allowFractions: boolean
}

/**
 * A key that is unique within one basket.
 *
 * The index is in there as well as the clock: two scans of the same barcode
 * inside the same millisecond are entirely possible with a scanner gun, and two
 * lines sharing a key makes React reuse the wrong row.
 */
export function basketKey(productId: number | null, index: number): string {
  return `${productId ?? 'x'}-${Date.now()}-${index}`
}

/** A fresh line from a product, at the price the catalogue gave. */
export function lineFromProduct(product: TillProduct, qty: number, index: number): BasketLine {
  return {
    key: basketKey(product.id, index),
    productId: product.id,
    productCode: product.code,
    description: product.description,
    productType: product.productType,
    departmentId: product.departmentId,
    qty,
    // A scanned price wins: a variable-weight barcode carries the money in it.
    unitPriceIncl: product.scannedPrice ?? product.priceIncl,
    discountPct: 0,
    vatRatePct: product.vatRatePct,
    unitCostExcl: product.costExcl,
    maxDiscountPct: product.maxDiscountPct,
    shelfPriceIncl: product.askPriceAtSale ? null : product.priceIncl,
    allowFractions: product.allowFractions,
  }
}

/**
 * Adds a product, merging with an existing line where that is what a cashier
 * would expect.
 *
 * Three products never merge, and each rule is one somebody will otherwise
 * "simplify" away:
 *
 *   · a line carrying a DISCOUNT, because merging would silently apply that
 *     discount to the newly-scanned unit as well;
 *   · a product PRICED AT THE COUNTER, because the second one may be a different
 *     price and merging would charge the first one's;
 *   · a line whose price was OVERRIDDEN off the shelf figure, for the same
 *     reason — the override was a decision about those units, not about the
 *     product.
 */
export function addToBasket(
  lines: BasketLine[],
  product: TillProduct,
  qty = 1,
): BasketLine[] {
  const mergeable = lines.findIndex(
    (l) =>
      l.productId === product.id &&
      l.discountPct === 0 &&
      l.shelfPriceIncl !== null &&
      l.unitPriceIncl === l.shelfPriceIncl,
  )

  if (mergeable !== -1 && !product.askPriceAtSale && product.scannedPrice == null) {
    const next = [...lines]
    // round to 3: quantities are DECIMAL(_,3) and a weighed item adds fractions,
    // so repeated addition without rounding drifts into 2.9999999999999996.
    next[mergeable] = { ...next[mergeable], qty: round(next[mergeable].qty + qty, 3) }
    return next
  }

  return [...lines, lineFromProduct(product, qty, lines.length)]
}

/** Replaces fields on one line. Unknown keys are ignored, not created. */
export function updateBasketLine(
  lines: BasketLine[],
  key: string,
  changes: Partial<BasketLine>,
): BasketLine[] {
  return lines.map((l) => (l.key === key ? { ...l, ...changes } : l))
}

export function removeBasketLine(lines: BasketLine[], key: string): BasketLine[] {
  return lines.filter((l) => l.key !== key)
}

/**
 * Steps a line's quantity, removing it at zero.
 *
 * Removing at zero rather than clamping is deliberate: a cashier pressing − on a
 * single unit means "take it off", and leaving a zero-quantity line behind gives
 * them a row that shows nothing and posts nothing.
 *
 * A product that does not allow fractions steps by whole units however small the
 * step asked for, so a − on a 1kg line of tinned beans cannot leave 0.5 of a tin.
 */
export function stepQty(lines: BasketLine[], key: string, delta: number): BasketLine[] {
  const line = lines.find((l) => l.key === key)
  if (!line) return lines
  const step = line.allowFractions ? delta : Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta)))
  const next = round(line.qty + step, 3)
  if (next <= 0) return removeBasketLine(lines, key)
  return updateBasketLine(lines, key, { qty: next })
}

/**
 * Whether a discount is within what this line permits.
 *
 * The ceiling is the product's own `maxDiscountPct`, which the catalogue carries.
 * Zero means "no discount allowed at all", NOT "unlimited" — the opposite reading
 * is the one that would quietly let staff discount protected lines to nothing.
 */
export function discountAllowed(line: BasketLine, pct: number): boolean {
  if (pct === 0) return true
  return pct > 0 && pct <= line.maxDiscountPct
}

/** Whether this price differs from what the shelf says. */
export function isPriceOverridden(line: BasketLine): boolean {
  return line.shelfPriceIncl !== null && line.unitPriceIncl !== line.shelfPriceIncl
}

/** How many individual items are in the basket — the count on the header chip. */
export function basketCount(lines: BasketLine[]): number {
  return lines.reduce((sum, l) => sum + l.qty, 0)
}
