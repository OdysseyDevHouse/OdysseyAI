'use server'

import { actorForOrThrow } from '@/lib/auth'
import { listSaved, getDocument, recallDocument } from '@/lib/site/salesDocuments'
import { getTillProduct } from '@/lib/site/tillSearch'
import { siteQuery } from '@/lib/siteDb'
import type { BasketLine } from '@/lib/basket'

/**
 * Server actions the touch till needs and the desk till does not.
 *
 * Everything else the POS does goes through `(app)/sales/actions` — the same
 * actions the desk till uses, so there is one gate (`sales.till`), one pricing
 * re-check, and one posting path. Only what is genuinely POS-shaped lives here.
 */

/** A parked basket, as the saved-sales list shows it. */
export type SavedSaleRow = {
  id: number
  customerName: string | null
  totalIncl: number
  /** How many LINES, which is what a cashier recognises a basket by. */
  lineCount: number
  updatedAt: string
}

/**
 * The parked baskets, with a line count.
 *
 * `listSaved` maps its documents with an empty `lines` array — it is a list
 * query and deliberately does not join the lines — so the count is fetched
 * separately rather than derived from a `lines.length` that is always zero.
 * Getting that wrong would show every parked sale as "0 items", which is exactly
 * the field a cashier uses to find theirs.
 *
 * Returns a narrowed shape rather than SalesDocument: the modal needs five
 * fields, and shipping the whole document to the browser sends a customer's
 * address and internal notes to a screen that has no use for either.
 */
export async function listSavedSalesAction(terminalId: number | null): Promise<SavedSaleRow[]> {
  // Throws rather than returning a refusal union: this is a read behind a screen
  // that already required `sales.till` to render, so a refusal here means
  // something is wrong rather than something the caller should handle. Same
  // choice the other read-only sales actions make.
  const { siteId } = await actorForOrThrow('sales.till')

  const docs = await listSaved(siteId, terminalId ?? undefined)
  if (docs.length === 0) return []

  const counts = await siteQuery<{ document_id: number; n: number }>(
    siteId,
    `SELECT document_id, COUNT(*) AS n
       FROM sales_document_lines
      WHERE document_id IN (${docs.map(() => '?').join(',')})
      GROUP BY document_id`,
    docs.map((d) => d.id),
  )
  const byDoc = new Map(counts.map((c) => [Number(c.document_id), Number(c.n)]))

  return docs.map((d) => ({
    id: d.id,
    customerName: d.customerName,
    totalIncl: d.totalIncl,
    lineCount: byDoc.get(d.id) ?? 0,
    // ISO rather than a Date: a Date crossing the server/client boundary in a
    // server action arrives as a string anyway, and saying so keeps the type
    // honest about what the browser actually receives.
    updatedAt: d.updatedAt.toISOString(),
  }))
}

/* ── Recalling a parked basket ───────────────────────────────────────────── */

/** A parked basket, converted back into something the till can put on screen. */
export type RecalledSale =
  | {
      ok: true
      documentId: number
      customerId: number | null
      customerName: string | null
      lines: RecalledLine[]
    }
  | { ok: false; error: string }

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
}

/**
 * Reads a parked basket back onto the till.
 *
 * ── WHY THIS IS NOT JUST `getDocument` ────────────────────────────────────
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
 */
export async function recallSaleForTillAction(
  documentId: number,
  priceStructureId: number | null,
): Promise<RecalledSale> {
  const { siteId } = await actorForOrThrow('sales.till')

  const doc = await getDocument(siteId, documentId)
  if (!doc) return { ok: false, error: 'That saved sale no longer exists.' }
  if (doc.status !== 'saved') {
    // Another till got there first, or it was discarded from the back office.
    return { ok: false, error: 'That sale has already been taken or discarded.' }
  }

  // Move it out of `saved` FIRST. Two tills recalling the same basket would
  // otherwise both put it on screen and the second would fail at finalise, in
  // front of a customer. recallDocument flips the status under the database's own
  // guard, so exactly one of them wins.
  const claimed = await recallDocument(siteId, documentId)
  if (!claimed.ok) return { ok: false, error: claimed.error }

  /* One query per distinct product, in parallel.
     getTillProduct exists for exactly this — its own docblock says "for
     re-pricing a recalled line" — and a parked basket is a handful of lines, so
     N small indexed lookups beat writing a second variant of a 60-line SELECT
     that would then have to be kept in step with the first. */
  const productIds = [
    ...new Set(doc.lines.map((l) => l.productId).filter((id): id is number => id !== null)),
  ]
  const products = await Promise.all(
    productIds.map((id) => getTillProduct(siteId, id, priceStructureId)),
  )
  const byId = new Map(
    products.filter((p): p is NonNullable<typeof p> => p !== null).map((p) => [p.id, p]),
  )

  return {
    ok: true,
    documentId: doc.id,
    customerId: doc.customerId,
    customerName: doc.customerName,
    lines: doc.lines.map((line, index) => {
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
        // Fresh from the product, not from the parked line — see the note above.
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
      }
    }),
  }
}
