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
 * Pulls the PLU and embedded value out of a scale barcode.
 *
 * Deliberately tolerant: a barcode that does not fit the configured shape returns
 * null rather than throwing, because an ordinary EAN-13 hits this path on every
 * scan that misses.
 */
export function parseVariableBarcode(
  code: string,
  config: { prefix: string; pluLength: number; divisor: number },
): VariableBarcode | null {
  const digits = code.trim()
  if (!/^\d{12,14}$/.test(digits)) return null
  if (!config.prefix || !digits.startsWith(config.prefix)) return null

  const pluLength = Number.isFinite(config.pluLength) ? config.pluLength : 5
  const divisor = Number.isFinite(config.divisor) && config.divisor > 0 ? config.divisor : 100

  const start = config.prefix.length
  const plu = digits.slice(start, start + pluLength)
  // Everything between the PLU and the check digit is the embedded value.
  const raw = digits.slice(start + pluLength, digits.length - 1)
  if (!plu || !raw) return null

  const value = Number(raw) / divisor
  if (!Number.isFinite(value) || value <= 0) return null

  return { plu, value }
}
