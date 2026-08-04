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
