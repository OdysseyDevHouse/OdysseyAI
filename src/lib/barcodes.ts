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
  /** Total barcode length this rule describes. 0 means "any length". */
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
 * Everything between the PLU and the check digit — NOT a fixed slice of
 * `valueLength` digits. That is the reading labels in the wild already have, and
 * changing it would re-interpret every barcode a trading shop scans today.
 * `valueLength` describes the barcode's TOTAL length and is used to reject a
 * code of the wrong size, which is what stops a rule on prefix `2` claiming a
 * plain EAN-13 that happens to start with a 2.
 *
 * The check digit is not verified, only skipped. A scale printing a
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
  if (rule.valueLength > 0 && digits.length !== rule.valueLength) return null

  const pluLength = Number.isFinite(rule.pluLength) && rule.pluLength > 0 ? rule.pluLength : 5
  const start = rule.prefix.length
  const plu = digits.slice(start, start + pluLength)
  /* Everything between the PLU and the check digit. `hasCheckDigit` false means
     the barcode ends at the value, which is a real shape — some in-store label
     printers emit one — and slicing a digit off it would divide the price by
     ten without a word. */
  const raw = rule.hasCheckDigit
    ? digits.slice(start + pluLength, digits.length - 1)
    : digits.slice(start + pluLength)
  if (plu.length !== pluLength || !raw) return null

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
