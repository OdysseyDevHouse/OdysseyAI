/**
 * Reading a barcode — pure, and deliberately NOT `server-only`.
 *
 * `parseVariableBarcode` lived in `site/tillSearch.ts`, which starts with
 * `import 'server-only'` because the rest of that file talks to the database.
 * The function itself never did. It is here so the OFFLINE till can call it: a
 * scale barcode carries the money in it, and a till that cannot read one while
 * the network is down cannot sell anything weighed — which in a grocer is most
 * of the shop.
 *
 * `tillSearch.ts` re-exports both of these, so nothing that imported them from
 * there needs changing.
 *
 * A GS1-128 / DataBar element string — which can carry a batch and expiry —
 * is a different shape entirely and is read by `parseGs1` in ./gs1. The two do
 * not overlap: each returns null on the other's input.
 */

export type VariableBarcode = { plu: string; value: number }

/**
 * One scale barcode shape.
 *
 * Named for the columns of the screen a shopkeeper fills in — see
 * sql/site/249_scale_barcode_rules.sql — rather than for what the parser below
 * happens to call them. `pluLength` is the "stock code" column: the digits that
 * identify the product.
 */
export type ScaleBarcodeRule = {
  prefix: string
  pluLength: number
  /** The last digit is a check digit, so it is not part of the value. */
  hasCheckDigit: boolean
  /**
   * How many digits hold the price or weight, counted back from the END of the
   * barcode — past the trailing check digit, when the rule has one.
   *
   * Counted from the end rather than forward from the stock code because a
   * scale is free to print digits BETWEEN the two that mean nothing to a till:
   * a check digit guarding the stock code, a department number, a filler. On a
   * real Avery label — 2 12345 6 01599 6 — the middle 6 is exactly that, and
   * reading forward would fold it into the price and charge R6015.99 for a
   * R15.99 item. Nothing on screen would say so.
   *
   * 0 means "everything between the stock code and the check digit", which is
   * what a rule carried over from the old three-setting config gets: that
   * config never recorded a width, and inventing one would re-read every label
   * a shop scans today.
   */
  valueLength: number
  /** 2 = the embedded figure is in cents, 3 = grams. */
  decimals: number
}

/**
 * Which rule a barcode belongs to.
 *
 * ── LONGEST PREFIX FIRST, THEN THE SHOP'S ORDER ───────────────────────────
 *
 * A shop with two scales can legitimately have a rule on `2` and another on
 * `21`, and a label starting 21 satisfies both. Taking the first match in list
 * order would make the answer depend on the order rows happen to come back in,
 * and would let a broad rule silently swallow every specific one beneath it —
 * a rule that never fires and no screen anywhere admitting it.
 *
 * Most specific wins instead, which is the same rule routing and CSS use and
 * needs nobody to think about ordering. `position` only breaks a tie between
 * two rules whose prefixes are the same LENGTH, where "more specific" has no
 * meaning and somebody has to choose.
 *
 * Callers pass rules in `position` order; a stable sort is what preserves that
 * as the tie-break.
 */
export function rulesByPrecedence(rules: readonly ScaleBarcodeRule[]): ScaleBarcodeRule[] {
  return [...rules].sort((a, b) => b.prefix.length - a.prefix.length)
}

/**
 * Pulls the PLU and embedded value out of a scale barcode.
 *
 * Deliberately tolerant: a barcode that does not fit any configured shape
 * returns null rather than throwing, because an ordinary EAN-13 hits this path
 * on every scan that misses.
 *
 * ── WHAT THE VALUE IS ─────────────────────────────────────────────────────
 *
 * The LAST `valueLength` digits before the check digit. Anything between the
 * stock code and that slice is skipped without being named, because a scale is
 * free to print digits there that mean nothing to a till — most commonly a
 * second check digit guarding the stock code, as on 2 12345 6 01599 6.
 *
 * Reading forward from the stock code instead — "everything up to the check
 * digit" — folds that middle digit into the price and rings up R6015.99 for a
 * R15.99 item. There is no exception to catch and nothing on screen to notice;
 * the first anyone knows is a cash-up that does not balance.
 *
 * `valueLength` 0 keeps the leftover-digits reading, for a rule that never
 * recorded a width. A rule that names one is also length-checked: the barcode
 * must be long enough to hold prefix + stock code + value + check digit, which
 * is what stops a rule on prefix `2` claiming a plain EAN-13 starting with 2.
 *
 * The check digits are not verified, only skipped. A scale printing a
 * non-standard check digit would otherwise stop scanning altogether, and a till
 * refusing a real product with a queue at the counter is a worse failure than
 * accepting a mis-keyed one — which then finds no product and is refused a
 * moment later anyway, with a message about the product rather than the digit.
 */
export function parseVariableBarcode(
  code: string,
  config: ScaleBarcodeRule | { prefix: string; pluLength: number; divisor: number },
): VariableBarcode | null {
  const digits = code.trim()
  if (!/^\d{6,18}$/.test(digits)) return null

  const rule = toRule(config)
  if (!rule.prefix || !digits.startsWith(rule.prefix)) return null

  const pluLength = Number.isFinite(rule.pluLength) && rule.pluLength > 0 ? rule.pluLength : 5
  const start = rule.prefix.length
  const plu = digits.slice(start, start + pluLength)
  if (plu.length !== pluLength) return null

  /* `hasCheckDigit` false means the barcode ends at the value, which is a real
     shape — some in-store label printers emit one — and slicing a digit off it
     would divide the price by ten without a word. */
  const end = rule.hasCheckDigit ? digits.length - 1 : digits.length
  const valueLength = Number.isFinite(rule.valueLength) ? rule.valueLength : 0

  /* A named width is taken from the END, so digits the scale prints between the
     stock code and the value are skipped rather than priced. The slice must not
     reach back into the stock code, or a barcode shorter than the shape claims
     would quietly read part of the PLU as money. */
  const from = valueLength > 0 ? end - valueLength : start + pluLength
  if (from < start + pluLength) return null

  const raw = digits.slice(from, end)
  if (!raw) return null

  const decimals = Number.isFinite(rule.decimals) && rule.decimals >= 0 ? rule.decimals : 2
  const value = Number(raw) / 10 ** decimals
  if (!Number.isFinite(value) || value <= 0) return null

  return { plu, value }
}

/**
 * The first rule that reads this barcode, and what it read.
 *
 * Returns the rule as well as the result, because the caller needs to know
 * WHICH shape matched — two rules can produce different PLUs from the same
 * digits, and a shop debugging "why did that scan as the wrong item" is asking
 * about the rule, not the number.
 */
export function parseWithRules(
  code: string,
  rules: readonly ScaleBarcodeRule[],
): { rule: ScaleBarcodeRule; parsed: VariableBarcode } | null {
  for (const rule of rulesByPrecedence(rules)) {
    const parsed = parseVariableBarcode(code, rule)
    if (parsed) return { rule, parsed }
  }
  return null
}

/**
 * Accepts the OLD three-field config as well as a rule.
 *
 * Kept rather than updating every caller in one sweep: the offline till holds a
 * cached copy of its settings, so a browser that has not synced since the
 * deploy is still calling this with `{ prefix, pluLength, divisor }`. Refusing
 * that shape would stop weighed items scanning on exactly the tills that are
 * offline — which is when they can least afford it.
 */
function toRule(config: ScaleBarcodeRule | { prefix: string; pluLength: number; divisor: number }): ScaleBarcodeRule {
  if ('decimals' in config) return config
  const divisor = Number.isFinite(config.divisor) && config.divisor > 0 ? config.divisor : 100
  return {
    prefix: config.prefix,
    pluLength: config.pluLength,
    hasCheckDigit: true,
    valueLength: 0,
    decimals: Math.round(Math.log10(divisor)),
  }
}
