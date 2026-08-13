import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery } from '../siteDb'
import { round, toNum } from '../decimals'
import { can, type CapabilitySet } from './permissions'
import { duePricesFor } from './priceSchedules'

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
 *
 * Nor is a SCHEDULED price whose moment has passed. A till applies a six
 * o'clock change on its own clock and the cron writes it to product_prices a
 * few minutes later; in between, the till is right and the table is stale.
 * Refusing those sales would stop the shop trading for exactly as long as that
 * gap lasts, with customers standing there — and would flag every offline sale
 * that syncs from the same window. See `duePricesFor` in site/priceSchedules.
 *
 * Nor is an INSTRUCTION. A burger with extra bacon costs more than the shelf
 * figure by design: the answers' price is folded into the line so that specials,
 * discounts and VAT all see the item at the price actually charged. Without
 * backing that out here, every modified line on every ordinary cashier's till
 * would be refused — which is not a stricter guard, it is a feature nobody can
 * use.
 *
 * That adjustment is RE-DERIVED from `instruction_options` rather than taken
 * from the payload, for exactly the reason the shelf price is re-read above: a
 * client that could name its own exemption could name any figure it liked, and
 * the guard would once again be comparing a number against itself.
 */

export type PriceCheckLine = {
  productId?: number | null
  description?: string
  unitPriceIncl: number
  discountPct?: number
  /**
   * An absolute discount — a document-level discount apportioned onto the line,
   * or one keyed directly. Checked as its EFFECTIVE percentage of the gross so
   * the cap means the same thing however the discount was expressed. Before
   * this field, a payload carrying discountIncl bypassed max_discount_pct
   * entirely — the guard read only the percentage.
   */
  discountIncl?: number
  /** Needed to turn discountIncl into a percentage. Ignored otherwise. */
  qty?: number
  /**
   * The answers chosen on this line.
   *
   * Only the id and the count are READ — a caller may hand over the whole
   * snapshot it is about to save, and any price on it is ignored in favour of
   * what `instruction_options` says. See the note above on why.
   */
  instructions?: readonly { optionId: number | null; qty: number }[]
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

  /*
   * Only asked when a price could actually be refused. A supervisor's sale
   * never reaches the comparison below, and neither does a discount-only
   * check — no reason to make either of them pay for the lookup.
   */
  const duePrices = mayOverridePrice
    ? new Map<number, number>()
    : await duePricesFor(siteId, priceStructureId, productIds)

  /*
   * What each chosen answer adds, READ FROM THE DATABASE.
   *
   * An id the client sent that does not resolve — deleted, or invented —
   * contributes nothing, so a line claiming an exemption it cannot justify is
   * refused exactly as an unexplained price would be. Same reason as re-reading
   * the shelf price: the payload cannot be allowed to certify itself.
   *
   * Skipped entirely for a supervisor, and for a sale with no answers on it.
   */
  const optionIds = mayOverridePrice
    ? []
    : [
        ...new Set(
          lines
            .flatMap((l) => (l.instructions ?? []).map((i) => i.optionId))
            .filter((id): id is number => typeof id === 'number' && id > 0),
        ),
      ]
  const optionPrices = optionIds.length
    ? new Map(
        (
          await siteQuery<RowDataPacket & { id: number; price_adjust: string | number }>(
            siteId,
            `SELECT id, price_adjust FROM instruction_options
              WHERE id IN (${optionIds.map(() => '?').join(',')})`,
            optionIds,
          ).catch(() => [])
        ).map((r) => [Number(r.id), toNum(r.price_adjust)]),
      )
    : new Map<number, number>()

  /** What this line's answers add to ONE of it, by the server's own figures. */
  const adjustFor = (line: PriceCheckLine): number =>
    round(
      (line.instructions ?? []).reduce(
        (sum, i) =>
          sum + (i.optionId ? (optionPrices.get(i.optionId) ?? 0) : 0) * (Number(i.qty) || 0),
        0,
      ),
      4,
    )

  for (const [index, line] of lines.entries()) {
    if (!line.productId) continue
    const product = byId.get(line.productId)
    if (!product) continue

    const where = line.description?.trim() || `Line ${index + 1}`

    if (!mayOverrideDiscount) {
      const cap = toNum(product.max_discount_pct)
      // An absolute discount is judged as the percentage it amounts to, so the
      // cap cannot be dodged by expressing the same reduction in rands.
      const gross = round((line.qty ?? 1) * line.unitPriceIncl, 2)
      const asked =
        line.discountIncl !== undefined && gross > 0
          ? round((line.discountIncl / gross) * 100, 3)
          : (line.discountPct ?? 0)
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
      const due = duePrices.get(line.productId) ?? null
      if (product.selling_price_incl === null && due === null) continue

      /*
       * Either price is acceptable: what the table says, and what a change
       * that is already due says. The till may legitimately be on either side
       * of the cron that reconciles them.
       */
      const shelf = product.selling_price_incl === null ? null : toNum(product.selling_price_incl)

      /*
       * The answers' own price is taken back off before comparing. It was folded
       * IN so the rest of the document prices the item correctly; here we are
       * asking a different question — "did somebody type a price?" — and the
       * bacon is not somebody typing a price.
       */
      const adjust = adjustFor(line)
      const asked = round(line.unitPriceIncl - adjust, 2)
      const allowed = [shelf, due].filter((p): p is number => p !== null)
      if (allowed.some((p) => Math.abs(asked - round(p, 2)) <= TOLERANCE)) continue

      // Named as the price the customer is about to be charged from, which is
      // the scheduled one if a change has landed and the shelf one otherwise.
      // Both sides are quoted WITHOUT the answers, so the two figures in the
      // message are comparable — quoting a built price against a shelf price
      // would read as a discrepancy that is not there.
      const expected = due ?? (shelf as number)
      return `${where}: the price is ${asked.toFixed(2)} but this product sells at ${expected.toFixed(2)}. A supervisor can authorise a change.`
    }
  }

  return null
}
