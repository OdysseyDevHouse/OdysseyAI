/**
 * The recipe weight factor: how much of a PURCHASED UNIT one made item uses.
 *
 * ── THE PROBLEM IT SOLVES ─────────────────────────────────────────────────
 *
 * Beef patties are bought as a 10 Kg box of raw mince and used 200 g at a
 * time. Neither figure is what the recipe line stores. compositionCost()
 * multiplies a line's quantity by the ingredient's unit cost — and that unit
 * cost is the cost of ONE STOCKED UNIT, the whole 10 Kg box. So the quantity
 * has to be the FRACTION of a box a burger consumes: 0.02.
 *
 * Nobody works that out reliably in their head, and getting it wrong by a
 * factor of a thousand is both easy and invisible: 200 in the box instead of
 * 0.02 costs the burger two hundred boxes of mince and nothing complains.
 *
 * ── THE ARITHMETIC ────────────────────────────────────────────────────────
 *
 *   factor = (usage converted into the buying unit) / buying quantity
 *          = (200 g -> 0.2 Kg) / 10 Kg
 *          = 0.02
 *
 * Deducting 0.02 of a box per burger is also exactly right for stock: fifty
 * burgers eat one box.
 */

/** The units a factor can be expressed in. Matches WEIGHT_DESCRIPTIONS. */
export type FactorUnit = 'Kg' | 'g' | 'L' | 'ml' | 'Each'

/** What the wizard shows for each unit — the screenshots' wording. */
export const UNIT_LABEL: Record<FactorUnit, string> = {
  Kg: 'Kg',
  g: 'grams',
  L: 'Litre',
  ml: 'ml',
  Each: 'Each',
}

export const FACTOR_UNITS: readonly FactorUnit[] = ['Kg', 'g', 'L', 'ml', 'Each']

/**
 * The unit the USAGE step offers, given what the product is bought in.
 *
 * A step DOWN, once. Nobody buys a 10 Kg box to use 2 Kg at a time — the
 * whole reason for the factor is that the using unit is smaller than the
 * buying one — so offering Kg again would mostly invite the mistake. A unit
 * already at the bottom of its scale stays put: grams stays grams, ml stays
 * ml, and Each has no smaller unit to step to.
 */
export function usageUnitFor(buying: FactorUnit): FactorUnit {
  switch (buying) {
    case 'Kg':
      return 'g'
    case 'L':
      return 'ml'
    // Already the smallest of its scale, or not a scale at all.
    case 'g':
    case 'ml':
    case 'Each':
      return buying
  }
}

/**
 * How many of `from` make one `to` — only ever within one scale.
 *
 * Returns null for a pairing that has no meaning: grams into litres is not a
 * conversion, it is a question about density that this app has no business
 * guessing at.
 */
function ratio(from: FactorUnit, to: FactorUnit): number | null {
  if (from === to) return 1
  if (from === 'g' && to === 'Kg') return 1 / 1000
  if (from === 'Kg' && to === 'g') return 1000
  if (from === 'ml' && to === 'L') return 1 / 1000
  if (from === 'L' && to === 'ml') return 1000
  return null
}

export type FactorInput = {
  /** How much arrives in one stocked unit — the 10 of "a 10 Kg box". */
  buyingQty: number
  buyingUnit: FactorUnit
  /** How much one made item consumes — the 200 of "200 g a burger". */
  usageQty: number
  usageUnit: FactorUnit
}

/**
 * The fraction of one purchased unit that one made item uses.
 *
 * null when the sum cannot be done honestly: a zero or negative buying
 * quantity (nothing to divide into), a negative usage, or units from two
 * different scales. The dialog shows nothing and refuses to save rather than
 * committing a number it had to invent.
 */
export function weightFactor(input: FactorInput): number | null {
  const { buyingQty, buyingUnit, usageQty, usageUnit } = input
  if (!Number.isFinite(buyingQty) || !Number.isFinite(usageQty)) return null
  // A zero pack is not a small pack; dividing by it yields Infinity.
  if (buyingQty <= 0 || usageQty < 0) return null

  const r = ratio(usageUnit, buyingUnit)
  if (r === null) return null

  const factor = (usageQty * r) / buyingQty
  if (!Number.isFinite(factor)) return null

  /* Four decimals, matching the qty column (DECIMAL(12,4)) and the rest of the
     recipe panel. Rounding here rather than at the input means what the dialog
     SHOWS is exactly what gets stored — a factor displayed as 0.0200 that was
     really 0.019999 would cost a different figure than the one on screen. */
  return Number(factor.toFixed(4))
}

/**
 * The sentence the last step reads back.
 *
 * Deliberately in the BUYING unit — "0.02 Kg of Beef Patties" — because that
 * is the unit the stored number is a fraction of, and seeing it named is what
 * makes 0.02 legible rather than mysterious.
 */
export function factorSentence(
  madeName: string,
  ingredientName: string,
  factor: number,
  buyingUnit: FactorUnit,
): string {
  const qty = factor.toLocaleString('en-ZA', { maximumFractionDigits: 4 })
  const unit = buyingUnit === 'Each' ? '' : ` ${UNIT_LABEL[buyingUnit]}`
  return `When selling a ${madeName} you will be using ${qty}${unit} of ${ingredientName}.`
}
