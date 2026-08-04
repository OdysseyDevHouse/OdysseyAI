// MySQL DECIMAL columns come back as strings (see db.ts — deliberate, so money
// never round-trips through a float). These are the only places that conversion
// should happen.

/** DECIMAL string (or null) -> number, for arithmetic and display. */
export function toNum(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Round half-up to `places`. JS's toFixed rounds half-to-even on some values. */
export function round(value: number, places = 2): number {
  const f = 10 ** places
  return Math.round((value + Number.EPSILON) * f) / f
}

/** Format for input into a DECIMAL column. */
export function toDecimalString(value: number | string, places = 4): string {
  return toNum(value).toFixed(places)
}

export function formatMoney(value: unknown, currency = 'R'): string {
  const n = toNum(value)
  const s = Math.abs(n)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${n < 0 ? '-' : ''}${currency}${s}`
}

export function formatQty(value: unknown): string {
  const n = toNum(value)
  // Weighed goods need the decimals; whole units read better without them.
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Selling price is stored VAT-inclusive; margin is computed against the
 * exclusive figure, so back the VAT out before comparing to cost.
 */
export function marginPercent(costExcl: number, sellIncl: number, vatPercent: number): number {
  const sellExcl = sellIncl / (1 + vatPercent / 100)
  if (sellExcl <= 0) return 0
  return round(((sellExcl - costExcl) / sellExcl) * 100, 2)
}

export function markupPercent(costExcl: number, sellIncl: number, vatPercent: number): number {
  const sellExcl = sellIncl / (1 + vatPercent / 100)
  if (costExcl <= 0) return 0
  return round(((sellExcl - costExcl) / costExcl) * 100, 2)
}
