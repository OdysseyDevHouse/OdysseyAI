import 'server-only'

import { getTillProduct } from '@/lib/site/tillSearch'
import type { getDocument } from '@/lib/site/salesDocuments'
import type { BasketLine } from '@/lib/basket'

/**
 * Turning a stored sales document back into basket lines.
 *
 * ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────
 *
 * Two different actions need it — recalling a parked basket, and collecting an
 * online order — and they live in different files because they are gated
 * differently and refuse for different reasons. What they must NOT differ on is
 * this mapping. A second copy would drift on the three fields that are read fresh
 * off the product rather than off the line, and the drift would show up as a
 * discount ceiling that applies to a recalled sale and not to a collected order:
 * a difference nobody discovers except by being burnt by it.
 *
 * A plain `server-only` module rather than an export from either actions file,
 * because everything exported from a `'use server'` file becomes a callable
 * endpoint. This takes a whole document and returns a whole basket; as an action
 * it would be an RPC that ships a document to the browser and back for no reason,
 * and a public one at that.
 */

/** One line of a recalled basket — a BasketLine, assembled server-side. */
export type RecalledLine = {
  key: string
  productId: number | null
  productCode: string | null
  description: string
  productType: BasketLine['productType']
  departmentId: number | null
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  unitCostExcl: number
  maxDiscountPct: number
  shelfPriceIncl: number | null
  allowFractions: boolean
  /**
   * The answers, and the note, exactly as they were stored.
   *
   * Re-read rather than recomputed, unlike the three product fields above: these
   * are what the CUSTOMER ordered, and a waiter recalling table 4's bill must get
   * back the burger that was actually sent to the kitchen. Looking them up from
   * the product's current questions would silently rewrite the order if the menu
   * had changed since — and dropping them would strip every modifier off the bill
   * and reprice the line, which is the same bug wearing a quieter face.
   */
  instructions: BasketLine['instructions']
  note: string
  /**
   * When the line was first rung (167), so its age survives being parked.
   *
   * Falls back to the moment of recall on a line stored before 167 — a wrong
   * answer is worse than a modest one here, and "0 minutes" on a tab reopened
   * after an upgrade is at least honest about knowing nothing.
   */
  orderedAt: number
  /**
   * How much of this line the kitchen already has (142).
   *
   * Carried onto the basket so the CARD can say so. Until now this lived only on
   * the server, which was enough to compute a ticket but left the waiter's screen
   * unable to distinguish a line the kitchen is already cooking from one it has
   * never heard of — the exact confusion the SENT badge exists to remove.
   */
  kitchenSentQty: number
}

/**
 * A stored document's lines, as the basket needs them.
 *
 * ── WHY THIS IS NOT JUST `doc.lines` ──────────────────────────────────────
 *
 * A stored line records what was CHARGED — quantity, price, discount, VAT, cost.
 * A basket line needs three things more, and none of them are on the line because
 * none of them are properties of the sale:
 *
 *   maxDiscountPct   the ceiling the line editor enforces
 *   shelfPriceIncl   what the shelf says, so an override can be told from it
 *   allowFractions   whether − may take half a unit
 *
 * They live on the PRODUCT, and they are re-read here rather than remembered.
 * That is the point: a basket parked yesterday against a product whose discount
 * ceiling has since been tightened must come back under the NEW ceiling, not the
 * one that applied when it was parked. Reading them fresh is what makes recall
 * safe rather than a way to smuggle stale rules back in.
 *
 * A product deleted since parking keeps its line — the description and price are
 * on the document, so the sale is still sellable — but gets a zero ceiling and no
 * shelf price, because there is no longer a product to say otherwise.
 *
 * One query per distinct product, in parallel. `getTillProduct` exists for
 * exactly this — its own docblock says "for re-pricing a recalled line" — and a
 * basket is a handful of lines, so N small indexed lookups beat writing a second
 * variant of a 60-line SELECT that would then have to be kept in step with the
 * first.
 */
export async function basketLinesForDocument(
  siteId: number,
  doc: NonNullable<Awaited<ReturnType<typeof getDocument>>>,
  priceStructureId: number | null,
): Promise<RecalledLine[]> {
  const productIds = [
    ...new Set(doc.lines.map((l) => l.productId).filter((id): id is number => id !== null)),
  ]
  const products = await Promise.all(
    productIds.map((id) => getTillProduct(siteId, id, priceStructureId)),
  )
  const byId = new Map(
    products.filter((p): p is NonNullable<typeof p> => p !== null).map((p) => [p.id, p]),
  )

  return doc.lines.map((line, index) => {
    const product = line.productId === null ? undefined : byId.get(line.productId)
    return {
      key: `r${doc.id}-${line.id}-${index}`,
      productId: line.productId,
      productCode: line.productCode,
      description: line.description,
      productType: line.productType,
      departmentId: line.departmentId,
      qty: line.qty,
      unitPriceIncl: line.unitPriceIncl,
      discountPct: line.discountPct,
      vatRatePct: line.vatRatePct,
      unitCostExcl: line.unitCostExcl,
      // Fresh from the product, not from the stored line — see the note above.
      maxDiscountPct: product?.maxDiscountPct ?? 0,
      shelfPriceIncl: product && !product.askPriceAtSale ? product.priceIncl : null,
      allowFractions: product?.allowFractions ?? false,
      /* From the LINE, not the product — see the note on the type. What was
         ordered is a fact about this bill, not about the menu as it stands
         now. `unitPriceIncl` above already carries their price, so nothing is
         re-folded here. */
      instructions: line.instructions.map((c) => ({
        groupId: c.groupId ?? 0,
        groupName: c.groupName,
        optionId: c.optionId ?? 0,
        optionName: c.optionName,
        qty: c.qty,
        priceAdjustIncl: c.priceAdjustIncl,
        productId: c.productId,
        stockQtyPer: c.stockQtyPer,
        printsOnKitchen: c.printsOnKitchen,
        printsOnReceipt: c.printsOnReceipt,
      })),
      note: line.note,
      // A line stored before 167 has no recorded order time. Recall is the
      // earliest moment we can honestly claim, so the age counts from here.
      orderedAt: line.orderedAt ?? Date.now(),
      kitchenSentQty: line.kitchenSentQty,
    }
  })
}
