import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { qtyDecimalsOf, toQtyDecimals, toNum } from '../decimals'

/**
 * Whether the quantities on a document are ones the products allow.
 *
 * ── WHY THIS IS ON THE SERVER ───────────────────────────────────────────
 *
 * `allow_fractions` and `qty_decimals` were enforced only in the browser: the
 * till's numeric pad refused a decimal point and the invoice grid formatted to
 * two places, and `validateDocument` accepted whatever number arrived. A rule
 * that lives entirely in a keypad is a suggestion — every save path here is a
 * plain server action, and the client composes the payload.
 *
 * Worse, the three selling screens disagreed about the rule rather than merely
 * failing to enforce it. The till asked the product; the invoice editor
 * hardcoded two decimals for everything; the delivery panel hardcoded three.
 * So the same product took a different quantity depending on which screen sold
 * it, which is the drift this exists to close.
 *
 * So the rule is checked here, where the save paths already converge, exactly
 * as `checkPricing` does for prices — and the two are called side by side.
 *
 * ── WHY IT REFUSES RATHER THAN ROUNDS ───────────────────────────────────
 *
 * `roundQty` rounds, and the CLIENT is right to: a scale weighing 1.2345kg of a
 * two-decimal product has measured more finely than the product is sold in, and
 * making a cashier retype a number they did not choose would be absurd.
 *
 * By the time a payload reaches the server that reasoning has run out. A
 * quantity that survives to here with more decimals than its product allows did
 * not come from a scale — the client would have rounded it — so it came from a
 * client that skipped the rule. Silently rounding one would write a quantity
 * nobody agreed to onto a document somebody pays against, and the slip would
 * disagree with the stock movement it caused. Refusing says which line and why.
 *
 * ── WHAT IS DELIBERATELY NOT CHECKED ────────────────────────────────────
 *
 * A line with no product. A free-text line on a quote has no product file to
 * ask, and inventing a rule for it would refuse documents that have always been
 * legitimate.
 *
 * A product id that does not resolve — deleted, or from another site. The line
 * is unenforceable rather than wrong, and refusing the whole sale over a
 * catalogue tidy-up would stop a shop trading. Same posture as `checkPricing`,
 * which lets an unresolved id through the price comparison.
 */

type QtyRow = RowDataPacket & {
  id: number
  allow_fractions: number
  qty_decimals: number | null
}

export type QtyCheckLine = {
  productId?: number | null
  description?: string
  qty: number
}

/**
 * Refuses the first line whose quantity the product does not permit, or null.
 *
 * Returns a message rather than throwing, for the reason `checkPricing` does: a
 * refused sale with a customer standing there needs to name the offending item.
 */
export async function checkQuantities(
  siteId: number,
  lines: readonly QtyCheckLine[],
): Promise<string | null> {
  const productIds = [...new Set(lines.map((l) => l.productId).filter((id): id is number => !!id))]
  if (productIds.length === 0) return null

  const rows = await siteQuery<QtyRow>(
    siteId,
    `SELECT id, allow_fractions, qty_decimals
       FROM products
      WHERE id IN (${productIds.map(() => '?').join(',')})`,
    productIds,
  )
  const byId = new Map(rows.map((r) => [r.id, r]))

  for (const [index, line] of lines.entries()) {
    if (!line.productId) continue
    const product = byId.get(line.productId)
    if (!product) continue

    const allowed = qtyDecimalsOf({
      allowFractions: !!product.allow_fractions,
      qtyDecimals: toQtyDecimals(product.qty_decimals),
    })

    /*
     * Compared through a rounded copy rather than by counting the digits in a
     * string. `String(0.1 + 0.2)` is "0.30000000000000004" — a quantity a client
     * built by adding two legitimate halves would be refused for a seventeenth
     * decimal that is a float artefact, not something anybody typed.
     *
     * Rounding to what IS allowed and comparing back asks the question that
     * actually matters: is this the same number the product permits? A genuine
     * 1.25 on a whole-unit product moves; a 0.30000000000000004 on a
     * two-decimal one does not.
     */
    const qty = toNum(line.qty)
    if (Math.abs(qty - Number(qty.toFixed(allowed))) < 1e-9) continue

    const where = `Line ${index + 1}`
    const name = line.description?.trim() || 'this product'
    return allowed === 0
      ? `${where}: ${name} is sold in whole units, so ${qty} is not a quantity it can take.`
      : `${where}: ${name} allows ${allowed} decimal${allowed === 1 ? '' : 's'} on a quantity, so ${qty} is too precise.`
  }

  return null
}
