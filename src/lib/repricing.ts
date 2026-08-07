import { round, toNum } from './decimals'
import { addVat, removeVat, sellExclFromMarkup, sellExclFromGp } from './pricing'

/**
 * What a bulk reprice computes, per product.
 *
 * Pure arithmetic, no database — the same reason lib/tenderMath.ts exists
 * apart from lib/site/tenderTypes.ts. The preview the user approves and the
 * write that follows must agree exactly, and the only way to guarantee that is
 * for both to call this.
 *
 * Everything here works in EXCLUSIVE money and converts at the edges, because
 * markup and GP are ratios of exclusive figures. Deriving a markup from an
 * inclusive price is the classic way to get every price 15% wrong.
 */

/** Where the new price is calculated from. */
export type RepriceSource =
  /** Cost — the figure this site prices from (average or last). */
  | { kind: 'cost' }
  /** Another price type's current price, e.g. Retail. */
  | { kind: 'structure'; structureId: number }

/** How the new price is derived from that source. */
export type RepriceMethod =
  | { kind: 'markup'; percent: number }
  | { kind: 'gp'; percent: number }
  /** Move the source price by a percentage: -10 is a 10% discount off it. */
  | { kind: 'adjust'; percent: number }

/**
 * How the result is tidied.
 *
 * Retail prices are rarely R14.3271. `endings` is the one that matters in a
 * shop: it forces a chosen fractional ending (.99, .95, .00) so a whole tier
 * comes out looking deliberate rather than computed.
 */
export type RepriceRounding =
  | { kind: 'none' }
  /** Nearest step: 0.05 for cash-friendly, 1 for whole rand. */
  | { kind: 'nearest'; step: number }
  /**
   * Force a fractional ending. `direction` defaults to the site's
   * price_ending_direction setting, resolved by the caller.
   */
  | { kind: 'ending'; cents: number; direction?: EndingDirection }

export type RepriceRule = {
  source: RepriceSource
  method: RepriceMethod
  rounding: RepriceRounding
  /** Never produce a price below cost. On by default; see applyRule. */
  floorAtCost?: boolean
}

export type RepriceInputs = {
  /** Cost excluding VAT — already resolved to this site's basis. */
  costExcl: number
  /** The source price INCLUSIVE, when the rule prices off another structure. */
  sourceIncl: number | null
  /** Selling VAT for this product, as a percentage. */
  sellingVatPercent: number
  /** The price this product currently holds under the target structure. */
  currentIncl: number | null
}

export type RepriceOutcome =
  | { ok: true; priceIncl: number; priceExcl: number; changed: boolean }
  /** Skipped, with a reason worth showing in the preview. */
  | { ok: false; reason: string }

/**
 * Which way a forced ending moves.
 *
 * Stores genuinely differ, so this is theirs to set rather than ours to assume.
 * On a .99 ending, R14.32 becomes R14.99 going up and R13.99 going down.
 *
 *   up      — never below the computed price. Protects margin. The common one.
 *   down    — never above it. Never charges more than the rule worked out.
 *   nearest — whichever ending is closer.
 */
export type EndingDirection = 'up' | 'down' | 'nearest'

export function toEndingDirection(value: unknown): EndingDirection {
  return value === 'down' || value === 'nearest' ? value : 'up'
}

/**
 * Applies a fractional ending.
 *
 * The tempting one-liner, `Math.round(value - ending) + ending`, is wrong for
 * every direction: it rounds a value already shifted down by nearly a rand, so
 * 14.32 - 0.99 is 13.33 and rounds to 13. Both candidates are computed here
 * instead, and the direction picks between them.
 */
export function applyEnding(
  value: number,
  cents: number,
  direction: EndingDirection = 'up',
): number {
  const ending = cents / 100
  // The ending at or below the value, and the one above it. When the value
  // already sits exactly on an ending, `below` IS the value and both
  // directions agree on it.
  const below = round(Math.floor(round(value - ending, 6)) + ending, 4)
  const above = round(below + 1, 4)

  let chosen: number
  if (Math.abs(value - below) < 0.00005) {
    chosen = below // already on an ending — never move it
  } else if (direction === 'up') {
    chosen = above
  } else if (direction === 'down') {
    chosen = below
  } else {
    chosen = value - below <= above - value ? below : above
  }

  // Nothing below the ending itself has a lower rand to sit on — a 40c item
  // with a .99 ending cannot become -0.01.
  return chosen < ending ? round(ending, 4) : round(chosen, 4)
}

export function applyRounding(value: number, rounding: RepriceRounding): number {
  switch (rounding.kind) {
    case 'nearest': {
      if (rounding.step <= 0) return round(value, 4)
      return round(Math.round(value / rounding.step) * rounding.step, 4)
    }
    case 'ending':
      return applyEnding(value, rounding.cents, rounding.direction ?? 'up')
    default:
      return round(value, 4)
  }
}

/**
 * The new price for one product, or a reason it was skipped.
 *
 * Skips rather than throws: a bulk run across 40 000 products will always meet
 * a few with no cost or no source price, and failing the whole run because one
 * product is incomplete would make the feature unusable.
 */
export function applyRule(rule: RepriceRule, inputs: RepriceInputs): RepriceOutcome {
  const { costExcl, sourceIncl, sellingVatPercent, currentIncl } = inputs

  // Work out the exclusive figure the method operates on.
  let baseExcl: number
  if (rule.source.kind === 'cost') {
    if (costExcl <= 0) return { ok: false, reason: 'No cost on the product' }
    baseExcl = costExcl
  } else {
    if (sourceIncl === null) return { ok: false, reason: 'No price under the source price type' }
    baseExcl = removeVat(sourceIncl, sellingVatPercent)
    if (baseExcl <= 0) return { ok: false, reason: 'Source price is zero' }
  }

  let targetExcl: number
  switch (rule.method.kind) {
    case 'markup': {
      // Markup is against COST by definition. Pricing "40% markup" off another
      // structure's price would mean something different from what it says, so
      // the rule is only offered against cost — guarded here as well.
      if (rule.source.kind !== 'cost') {
        return { ok: false, reason: 'Markup prices off cost only' }
      }
      targetExcl = sellExclFromMarkup(baseExcl, rule.method.percent)
      break
    }
    case 'gp': {
      if (rule.source.kind !== 'cost') {
        return { ok: false, reason: 'GP prices off cost only' }
      }
      const sell = sellExclFromGp(baseExcl, rule.method.percent)
      if (sell === null) return { ok: false, reason: 'A GP of 100% or more is unreachable' }
      targetExcl = sell
      break
    }
    case 'adjust': {
      targetExcl = round(baseExcl * (1 + rule.method.percent / 100), 4)
      break
    }
  }

  if (!Number.isFinite(targetExcl) || targetExcl <= 0) {
    return { ok: false, reason: 'Works out to zero or less' }
  }

  // Round the INCLUSIVE price: that is the figure on the shelf edge, and it is
  // what a .99 ending is supposed to land on. Rounding exclusive and then
  // adding VAT gives R17.24 from a "R14.99" price.
  let priceIncl = applyRounding(addVat(targetExcl, sellingVatPercent), rule.rounding)

  // A rounding rule can pull a price back under cost — a .95 ending on a thin
  // margin. Selling below cost should be a decision, never a side effect.
  if (rule.floorAtCost !== false && costExcl > 0) {
    const costIncl = addVat(costExcl, sellingVatPercent)
    if (priceIncl < costIncl) {
      return { ok: false, reason: 'Would price below cost' }
    }
  }

  priceIncl = round(priceIncl, 4)
  return {
    ok: true,
    priceIncl,
    priceExcl: removeVat(priceIncl, sellingVatPercent),
    // Unchanged rows are still written (harmless) but counted separately, so
    // the summary can say "1 204 changed" rather than "40 006 updated".
    changed: currentIncl === null || Math.abs(toNum(currentIncl) - priceIncl) > 0.00005,
  }
}
