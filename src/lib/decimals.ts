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

/**
 * How many decimals this shop shows on a quantity and on a cost.
 *
 * ── WHY A MODULE-LEVEL VALUE AND NOT A PARAMETER EVERYWHERE ─────────────────
 *
 * `formatQty` has 248 call sites across 67 files, and `formatMoney` far more.
 * Threading a precision through every one of them would be a change to every
 * screen in the product to alter two numbers — and the ones it missed would be
 * silent, showing yesterday's format beside today's on the same table.
 *
 * So the preference is SET rather than passed. It is a display rule with one
 * answer per shop, which is exactly the shape of a module-level value.
 *
 * ── WHICH MAKES THE LIFETIME THE THING TO GET RIGHT ─────────────────────────
 *
 * A Node process serves many sites. A value set once at boot would be whichever
 * shop happened to render first, and every other shop would silently inherit
 * it — the same class of bug the per-site mail transport exists to fix.
 *
 * So it is set per REQUEST, from the layout, and read synchronously by the
 * formatters. On the server that is safe because a request is handled to
 * completion before the next one's layout runs; in the browser there is one
 * site per tab and the value arrives with the page. Anything that formats
 * outside a request — a cron, a test — gets the defaults, which is what it
 * should get.
 *
 * ── AND WHY THE DEFAULTS ARE TODAY'S BEHAVIOUR ──────────────────────────────
 *
 * `QTY_TRIM` reproduces exactly what this function did before the setting
 * existed: up to three decimals, trailing zeros trimmed. A site that never
 * opens the setup screen sees no change at all, and a code path that never
 * learns the shop's preference degrades to what it printed yesterday rather
 * than to something new.
 */

/** Up to three decimals, trailing zeros trimmed — what formatQty always did. */
const QTY_TRIM = -1

const precision = {
  /** -1 means "trim", 0-3 means a fixed number of places. */
  qty: QTY_TRIM as number,
  cost: 2,
}

/**
 * Tell the formatters what this shop prefers. Called once per request, from the
 * layout, and once on the client when the page hydrates.
 *
 * Out-of-range values are IGNORED rather than clamped: a bad number here is a
 * setting that failed validation or a caller that passed nonsense, and quietly
 * keeping the last good value is better than inventing a format nobody chose.
 */
export function setDisplayPrecision(input: { qty?: number; cost?: number }): void {
  if (input.qty !== undefined && Number.isInteger(input.qty) && input.qty >= 0 && input.qty <= 3) {
    precision.qty = input.qty
  }
  if (
    input.cost !== undefined &&
    Number.isInteger(input.cost) &&
    input.cost >= 2 &&
    input.cost <= 4
  ) {
    precision.cost = input.cost
  }
}

/** What the formatters are currently using. For a screen that wants to say so. */
export function displayPrecision(): { qty: number; cost: number } {
  return { qty: precision.qty, cost: precision.cost }
}

/**
 * A quantity, as this shop shows them.
 *
 * ── THE WEIGHED ESCAPE HATCH ────────────────────────────────────────────────
 *
 * `exact` keeps every decimal the number has, whatever the shop's setting says.
 * It is for a WEIGHED line, and it is not a nicety: 1.5kg shown as "2" on an
 * invoice is a wrong figure on a document somebody pays against, and the shop
 * that set 0 decimals was describing how it counts tins, not how it weighs
 * cheese. A display preference must never be able to misstate what was sold.
 *
 * Callers that know a line is a scale item pass `exact`. Everything else takes
 * the shop's answer.
 */
export function formatQty(value: unknown, opts?: { exact?: boolean }): string {
  const n = toNum(value)

  if (opts?.exact || precision.qty === QTY_TRIM) {
    // Weighed goods need the decimals; whole units read better without them.
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  }

  /*
   * ── A FRACTION IS NEVER ROUNDED AWAY ─────────────────────────────────────
   *
   * The setting says how many decimals to SHOW; it does not license showing a
   * different number. At 0 decimals a 1.5kg line would print as "2", which on
   * an invoice is not a tidier display but a wrong figure on a document
   * somebody pays against — and the shop that chose 0 was describing how it
   * counts tins, not how it weighs cheese.
   *
   * Checked on the VALUE rather than on a scale-item flag because a sales line
   * does not carry one: `sales_document_lines` stores a DECIMAL(12,3) qty and
   * nothing about where it came from. The value is the better test anyway — it
   * catches a fractional quantity from any source, including a part-delivered
   * order line and a recipe component, without every caller having to know.
   *
   * So the setting rounds nothing. It pads whole numbers to a consistent width
   * and it leaves anything with a real fraction alone, which is the only
   * version of this that cannot misstate what was sold.
   */
  if (!Number.isInteger(n)) {
    return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  }

  return n.toFixed(precision.qty)
}

/**
 * A cost, as this shop shows them.
 *
 * Separate from `formatMoney` because it answers a different question. Money is
 * what a customer pays and has two decimals because that is what a currency
 * has; a COST is what the business paid, which for a distributor buying at
 * 0.0875 a unit genuinely carries four. Rounding that to 0.09 in a margin
 * calculation is how a slow leak goes unnoticed.
 *
 * Display only — the column keeps all four digits whatever this shows.
 */
export function formatCost(value: unknown, currency = 'R'): string {
  const n = toNum(value)

  /*
   * ── THE INTEGER PART ONLY ────────────────────────────────────────────────
   *
   * formatMoney's separator regex groups every run of three digits counting
   * from the END of the string, which is correct at exactly two decimals and
   * wrong at any other number: at four, "1234.5000" becomes "1 234.5 000",
   * because the trailing zeros are themselves a group of three.
   *
   * Splitting first is the fix, and it is why this cannot simply call
   * formatMoney with a places argument.
   */
  const [whole, fraction] = Math.abs(n).toFixed(precision.cost).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${n < 0 ? '-' : ''}${currency}${grouped}${fraction ? `.${fraction}` : ''}`
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
