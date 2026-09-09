import { round, toNum } from './decimals'

/**
 * Cost and price derivations.
 *
 * Only two figures are stored per product — cost EXCLUSIVE of VAT and selling
 * price INCLUSIVE of VAT. Everything else on the pricing panel (inclusive cost,
 * exclusive selling price, markup, GP) is computed here. Storing them as well
 * would let the copies drift the moment a VAT rate changed.
 *
 * Markup and GP are different ratios of the same two numbers and are routinely
 * confused:
 *   markup % = profit / cost      — what you add on
 *   GP %     = profit / sell      — what you keep
 * A 100% markup is a 50% GP.
 */

export type CostBasis = 'average' | 'last'

export function addVat(exclusive: number, vatPercent: number): number {
  return round(exclusive * (1 + vatPercent / 100), 4)
}

export function removeVat(inclusive: number, vatPercent: number): number {
  return round(inclusive / (1 + vatPercent / 100), 4)
}

/** The cost figure this site prices from. */
export function effectiveCost(
  averageCost: number,
  lastCost: number,
  basis: CostBasis,
): number {
  return basis === 'last' ? lastCost : averageCost
}

export function markupPercent(costExcl: number, sellExcl: number): number {
  if (costExcl <= 0) return 0
  return round(((sellExcl - costExcl) / costExcl) * 100, 2)
}

export function gpPercent(costExcl: number, sellExcl: number): number {
  if (sellExcl <= 0) return 0
  return round(((sellExcl - costExcl) / sellExcl) * 100, 2)
}

/** Exclusive selling price that yields the given markup on cost. */
export function sellExclFromMarkup(costExcl: number, markup: number): number {
  return round(costExcl * (1 + markup / 100), 4)
}

/**
 * Exclusive selling price that yields the given GP.
 *
 * A GP of 100% or more is unreachable — it would need an infinite price — so
 * it is refused rather than returning a nonsense number.
 */
export function sellExclFromGp(costExcl: number, gp: number): number | null {
  if (gp >= 100) return null
  return round(costExcl / (1 - gp / 100), 4)
}

export type PriceLine = {
  /** Stored. */
  sellIncl: number
  sellExcl: number
  markup: number
  gp: number
  /** Profit per unit, excluding VAT on both sides. */
  profit: number
}

/** Every derived figure for one selling price, given cost and VAT. */
export function priceLine(
  sellIncl: number,
  costExcl: number,
  sellingVatPercent: number,
): PriceLine {
  const sellExcl = removeVat(sellIncl, sellingVatPercent)
  return {
    sellIncl: round(sellIncl, 4),
    sellExcl,
    markup: markupPercent(costExcl, sellExcl),
    gp: gpPercent(costExcl, sellExcl),
    profit: round(sellExcl - costExcl, 4),
  }
}

export type CostLine = {
  lastCost: number
  averageCost: number
  /** Whichever of the two this site prices from. */
  effective: number
  /** The effective cost with purchase VAT added. */
  effectiveIncl: number
  basis: CostBasis
}

export function costLine(
  averageCost: unknown,
  lastCost: unknown,
  purchaseVatPercent: number,
  basis: CostBasis,
): CostLine {
  const avg = toNum(averageCost)
  const last = toNum(lastCost)
  const effective = effectiveCost(avg, last, basis)
  return {
    lastCost: last,
    averageCost: avg,
    effective,
    effectiveIncl: addVat(effective, purchaseVatPercent),
    basis,
  }
}

/**
 * What a COST change does to a selling price.
 *
 * This is the rule behind products.price_calc, and it is asked wherever a cost
 * moves — the product form, the bulk pricing grid, and a GRV. The two settings
 * are each other's mirror, and between them they decide which of the three
 * figures (cost, markup, price) is the one allowed to give:
 *
 *   'markup'  — the markup is the product's identity. A 20% product stays a
 *               20% product, so a new cost pushes the SELLING PRICE.
 *   'selling' — the shelf price is the product's identity. R100 stays R100, so
 *               a new cost is absorbed by the MARGIN and the price holds.
 *
 * Returns the new INCLUSIVE selling price, or null when the price must not
 * move — which is both the 'selling' case and every case with nothing to
 * compute from. Null means "leave the stored price alone", never "price zero".
 *
 * The markup held is the one this tier is currently on, recomputed per tier
 * rather than taken from a single figure: a product with retail and wholesale
 * tiers is on two different markups, and holding one of them would flatten the
 * other onto it.
 */
export function repricedForCostChange({
  priceCalc,
  oldCostExcl,
  newCostExcl,
  currentSellIncl,
  sellingVatPercent,
}: {
  priceCalc: 'selling' | 'markup'
  oldCostExcl: number
  newCostExcl: number
  currentSellIncl: number
  sellingVatPercent: number
}): number | null {
  if (priceCalc !== 'markup') return null

  // Nothing to hold: a markup can only be read off a cost that existed. A
  // product costed for the first time keeps its price and simply reports
  // whatever margin that turns out to be — inventing one from a zero cost
  // would price every such line at cost.
  if (!(oldCostExcl > 0) || !(newCostExcl > 0)) return null
  if (!(currentSellIncl > 0)) return null

  const markup = markupPercent(oldCostExcl, removeVat(currentSellIncl, sellingVatPercent))
  return addVat(sellExclFromMarkup(newCostExcl, markup), sellingVatPercent)
}
