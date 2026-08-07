import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { round, toNum } from '../decimals'
import { can, type CapabilitySet } from './permissions'

/**
 * Whether the prices and discounts on a document are ones this person may set.
 *
 * ── WHY THIS IS ON THE SERVER ───────────────────────────────────────────
 *
 * `sales.price_override` and `sales.discount_override` were both enforced only
 * in the browser: the till greyed a box out and the invoice editor disabled a
 * cell, and `validateDocument` accepted whatever number arrived. A capability
 * that lives entirely in a disabled attribute is a suggestion — the request it
 * guards is a plain server action, and the client composes it.
 *
 * So the rule is checked here, where every save path already converges, rather
 * than in each screen that happens to offer an input.
 *
 * ── WHY THE PRICE IS RE-READ RATHER THAN TRUSTED ────────────────────────
 *
 * The payload carries `unitPriceIncl`, which is the number being validated —
 * comparing it against itself proves nothing. The structure price is therefore
 * read from `product_prices` at save time, and a line priced above or below it
 * is an override regardless of what the client claims.
 *
 * ── WHAT IS DELIBERATELY NOT AN OVERRIDE ────────────────────────────────
 *
 * A product flagged `ask_price_at_sale` has no shelf price to depart from —
 * cut flowers, fabric off a roll, a repair quoted at the counter. Typing its
 * price IS the normal path, so requiring a supervisor for one would stop the
 * till working. Same for a line with no product at all.
 */

export type PriceCheckLine = {
  productId?: number | null
  description?: string
  unitPriceIncl: number
  discountPct?: number
}

/** A rounding tolerance, not a policy: a cent of drift is not an override. */
const TOLERANCE = 0.01

type PriceRow = RowDataPacket & {
  id: number
  max_discount_pct: string | number
  ask_price_at_sale: number
  selling_price_incl: string | number | null
}

/**
 * Refuses the first line the actor may not price that way, or null.
 *
 * Returns a message rather than throwing so a till can show it beside the
 * offending line — a refused sale with a customer standing there needs to say
 * which item and why.
 */
export async function checkPricing(
  siteId: number,
  capabilities: CapabilitySet,
  priceStructureId: number | null,
  lines: readonly PriceCheckLine[],
): Promise<string | null> {
  const mayOverridePrice = can(capabilities, 'sales.price_override')
  const mayOverrideDiscount = can(capabilities, 'sales.discount_override')

  // Both permitted: nothing below can refuse anything, so skip the query.
  if (mayOverridePrice && mayOverrideDiscount) return null

  const productIds = [...new Set(lines.map((l) => l.productId).filter((id): id is number => !!id))]
  if (productIds.length === 0) return null

  const rows = await siteQuery<PriceRow>(
    siteId,
    `SELECT p.id, p.max_discount_pct, p.ask_price_at_sale,
            pp.selling_price_incl
       FROM products p
       LEFT JOIN product_prices pp
              ON pp.product_id = p.id AND pp.price_structure_id = ?
      WHERE p.id IN (${productIds.map(() => '?').join(',')})`,
    [priceStructureId, ...productIds],
  )
  const byId = new Map(rows.map((r) => [r.id, r]))

  for (const [index, line] of lines.entries()) {
    if (!line.productId) continue
    const product = byId.get(line.productId)
    if (!product) continue

    const where = line.description?.trim() || `Line ${index + 1}`

    if (!mayOverrideDiscount) {
      const cap = toNum(product.max_discount_pct)
      const asked = line.discountPct ?? 0
      // A zero cap means "no discount allowed on this product", which is a
      // real setting rather than an unset one — 037 gave the column meaning.
      if (asked > cap + TOLERANCE) {
        return cap > 0
          ? `${where}: ${asked}% is more than the ${cap}% this product allows. A supervisor can authorise it.`
          : `${where}: this product cannot be discounted. A supervisor can authorise it.`
      }
    }

    if (!mayOverridePrice) {
      // Nothing to depart from — see the note above on ask_price_at_sale.
      if (product.ask_price_at_sale) continue
      if (product.selling_price_incl === null) continue

      const shelf = toNum(product.selling_price_incl)
      if (Math.abs(round(line.unitPriceIncl, 2) - round(shelf, 2)) > TOLERANCE) {
        return `${where}: the price is ${line.unitPriceIncl.toFixed(2)} but this product sells at ${shelf.toFixed(2)}. A supervisor can authorise a change.`
      }
    }
  }

  return null
}
