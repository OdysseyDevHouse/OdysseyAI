import 'server-only'

/**
 * Overlaying a partial file onto the record it matched.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Because `updateProduct` writes every column unconditionally, and the helper
 * that builds its property values coalesces an ABSENT field to a DEFAULT
 * rather than to what is stored:
 *
 *     input.visibleInPos === false ? 0 : 1      // absent ⇒ visible
 *     (input.maxDiscountPct ?? 0).toFixed(3)    // absent ⇒ 0
 *     input.weightDescription?.trim() || 'Kg'   // absent ⇒ 'Kg'
 *     (input.lastCost ?? 0).toFixed(4)          // absent ⇒ cost wiped
 *
 * That is correct for the product form, which always submits every field. It is
 * catastrophic for an import: a two-column file of Code and Retail Price handed
 * straight to `updateProduct` would, on every row it touched, zero the cost,
 * clear the barcode and department, drop both VAT rates and reset every
 * property flag. `updateCustomer` and `updateSupplier` have the same shape.
 *
 * So the import never hands an update function a partial input. It loads the
 * stored record, overlays only what the file actually mapped, and passes a
 * COMPLETE input — leaving those functions untouched, since every other caller
 * relies on their current behaviour and changing it would put a large
 * regression surface inside a new feature.
 *
 * ── WHY `mapped` AND NOT `Object.keys(draft)` ────────────────────────────
 *
 * Because a mapped column with a blank cell is a real instruction for some
 * fields and silence for others, and only the mapping knows which case a blank
 * is in. A draft that simply lacks a key cannot tell "the file has no Barcode
 * column" from "the file has one and this row left it empty" — and those must
 * do different things.
 */
export function mergeForUpdate<T extends Record<string, unknown>>(
  existing: T,
  draft: Record<string, unknown>,
  mapped: ReadonlySet<string>,
): T {
  const merged: Record<string, unknown> = { ...existing }

  for (const key of mapped) {
    // A key the file mapped but this row left blank is absent from the draft
    // unless the field opted into blankClears, in which case it is explicitly
    // null. Both cases are handled by only copying what is actually present.
    if (key in draft) merged[key] = draft[key]
  }

  return merged as T
}

/**
 * Whether the file said anything at all about a field.
 *
 * The guard in front of any REPLACE-semantics write. `saveProductSuppliers`
 * replaces a product's whole supplier set, which is right for the form that
 * shows every row and wrong for an import file that shows one supplier or none
 * — calling it with an empty list because the file had no supplier column would
 * strip every supplier from every product in the file.
 */
export function fileSpeaksTo(mapped: ReadonlySet<string>, ...keys: string[]): boolean {
  return keys.some((key) => mapped.has(key))
}
