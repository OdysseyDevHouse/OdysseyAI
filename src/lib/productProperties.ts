/**
 * The fixed choice lists behind the product Properties tab.
 *
 * Each follows the productTypes.ts pattern: an id stored in the column, a name
 * shown in the select, and a narrowing function that falls back to the default
 * rather than throwing — an unrecognised value in an old row should render an
 * editable form, not break the page.
 */

/* ── Variable type ─────────────────────────────────────────────────────── */

/** What a variable barcode encodes for this product. */
export type VariableTypeId = 'none' | 'price' | 'weight'

export const VARIABLE_TYPES: { id: VariableTypeId; name: string }[] = [
  { id: 'none', name: 'None' },
  { id: 'price', name: 'Variable Price' },
  { id: 'weight', name: 'Variable Weight' },
]

const VARIABLE_IDS = new Set<string>(VARIABLE_TYPES.map((t) => t.id))

export function toVariableType(value: unknown): VariableTypeId {
  const raw = String(value ?? '').trim().toLowerCase()
  return VARIABLE_IDS.has(raw) ? (raw as VariableTypeId) : 'none'
}

/* ── Price calculation ─────────────────────────────────────────────────── */

/**
 * Which figure survives a cost change.
 *
 * 'selling' holds the shelf price and lets the margin move; 'markup' holds the
 * margin and moves the shelf price. One or the other must give — this records
 * which.
 */
export type PriceCalcId = 'selling' | 'markup'

export const PRICE_CALCS: { id: PriceCalcId; name: string }[] = [
  { id: 'selling', name: 'Selling Price Fixed' },
  { id: 'markup', name: 'Markup Fixed' },
]

const PRICE_CALC_IDS = new Set<string>(PRICE_CALCS.map((t) => t.id))

export function toPriceCalc(value: unknown): PriceCalcId {
  const raw = String(value ?? '').trim().toLowerCase()
  return PRICE_CALC_IDS.has(raw) ? (raw as PriceCalcId) : 'selling'
}

/* ── Units ─────────────────────────────────────────────────────────────── */

/**
 * Free-ish text rather than ids: these are labels printed on shelf tickets and
 * read by staff, and a store may well want one this list does not have. The
 * lists drive the select; the column stores whatever is chosen.
 */
export const WEIGHT_DESCRIPTIONS = ['Kg', 'g', 'L', 'ml', 'Each'] as const

export const PACK_DESCRIPTIONS = ['None', 'Pack', 'Case', 'Box', 'Bag', 'Crate', 'Tray'] as const
