import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { supplierQueryOne } from './customerDb'
import { round, toNum } from '../decimals'
import { apportionDiscount, weightedAverageCost } from '../documentMath'
import { nextDocumentNumber } from './sequences'
import { recordMovement } from './stockMovements'
import {
  explodingProducts,
  resolveComponents,
  type ResolvedComponent,
} from './productComposition'
import { mainLocationIdTx } from './stockLocations'
import { writePriceRows, type PriceRow } from './reprice'
import { receiveSerialsTx, removeReceivedSerialsTx } from './serials'
import { getSetting } from './settings'
import { guardPosting } from './periodLocks'
import { postSupplierTransaction } from './supplierLedger'
import { dueDateFor } from './ledger'
import type { Actor } from './activityLog'
import type { ProductTypeId } from '../productTypes'

/**
 * Receiving goods — the moment stock and cost both move.
 *
 * A GRV is the mirror of finalising a sale, and it is the ONLY thing in the
 * system that writes products.average_cost. That column has been non-writable
 * by the product form since the first migration, with a comment saying it is
 * "a consequence of purchases and stock movements"; this is that consequence.
 *
 * ── WHAT HAPPENS, IN ORDER, INSIDE ONE TRANSACTION ───────────────────────
 *
 *   1. Charges are apportioned across the lines, so cost is LANDED cost.
 *   2. Each line moves stock IN and blends its landed cost into the average.
 *   3. last_cost is set to what was just paid.
 *   4. The supplier ledger is credited — we now owe them.
 *   5. The number is claimed LAST, immediately before commit.
 *
 * Step 5 matters for the same reason it does on a sale: claiming the number
 * takes an exclusive lock on the sequence row held until commit, so doing it
 * first would serialise everything else behind it.
 */

export type ReceiveLineInput = {
  /** The order line being fulfilled, when receiving against a PO. */
  orderLineId?: number | null
  productId: number | null
  /**
   * Which stock location these goods went into. Omitted means the main one.
   *
   * Held per LINE rather than per document because that is the whole point:
   * ten stock codes on one delivery can land in different rooms, and forcing
   * one destination per GRV would mean splitting a supplier invoice to model
   * where the goods physically went.
   */
  locationId?: number | null
  productCode?: string | null
  supplierCode?: string | null
  description: string
  productType?: string
  departmentId?: number | null
  qtyOrdered?: number
  /** What actually arrived. Partial deliveries are the normal case. */
  qtyReceived: number
  /**
   * Free units — "buy 10, get 1 free".
   *
   * They increase what arrived but NOT what is owed, so the landed cost
   * divides by qtyReceived + qtyBonus. Dividing by qtyReceived alone overstates
   * the cost of every promotional buy, and a GRV is the only thing that writes
   * average_cost, so the error blends in and compounds. See 090.
   */
  qtyBonus?: number
  /** Per unit, EXCLUSIVE of VAT — how a supplier invoice is written. */
  unitCostExcl: number
  /**
   * What the shelf price should BECOME, INCLUSIVE of VAT (193).
   *
   * The buyer prices the delivery while the supplier's invoice is in their
   * hand — that is what the Selling, Markup % and GP % columns on the
   * receiving grid have always been for. Applied to the default price
   * structure when the receipt POSTS, and never when a draft is saved: a
   * delivery still being keyed must not move a price the till is charging.
   *
   * NULL means LEAVE THE PRICE ALONE, which is not the same as 0. The grid
   * seeds every line with the product's current price, so treating
   * "unchanged" as an instruction would have every delivery rewrite the shelf
   * from a figure that was only ever a starting point.
   */
  sellingPriceIncl?: number | null
  discountPct?: number
  /** An absolute discount on this line, which wins over the percentage. See 087. */
  discountAmount?: number
  vatRatePct: number
  /**
   * The serial numbers that arrived on this line, for a serial-tracked product.
   *
   * Captured with the receipt rather than afterwards because this is the only
   * moment the delivery note is in the receiver's hand. One per unit, and the
   * receipt refuses rather than posts if the count disagrees — see
   * receiveSerialsTx for why that is a refusal and not a skip.
   */
  serials?: string[]
  /** Manufacturer warranty expiry, applied to every serial on this line. */
  warrantyUntil?: string | null
  /**
   * The lot identity for a batch-tracked product (148), captured with the
   * receipt for the same reason serials are: this is the only moment the
   * delivery note is in the receiver's hand. At least one of the two is
   * required for a batch line; expiry alone names the lot EXP-<date>.
   */
  batchNo?: string | null
  expiryDate?: string | null
}

/**
 * One charge on a delivery — freight, duty, a pallet deposit.
 *
 * EVERY charge is apportioned into landed cost, whoever billed it: the goods
 * cost what they cost to get onto the shelf. What `supplierId` decides is who
 * gets CREDITED for it. See 088_purchase_charges.sql.
 */
export type ReceiveChargeInput = {
  /**
   * Who invoiced it. Null means the goods supplier billed it on the same
   * invoice — the behaviour chargesExcl has always had, and the default.
   *
   * A value means a SEPARATE invoice: their own creditor posting, and a GL
   * line to freight-in rather than to stock.
   */
  supplierId?: number | null
  description: string
  /** EXCLUSIVE of VAT, like every other purchase figure. */
  amountExcl: number
  vatRatePct?: number
  /** Their invoice number, which the payment run matches against. */
  theirInvoiceNo?: string | null
}

export type ReceiveInput = {
  supplierId: number
  /** The purchase order being received against, if any. */
  orderId?: number | null
  supplierInvoiceNo?: string | null
  documentDate?: string
  /**
   * Freight and the like, spread across the lines so cost is landed cost.
   *
   * Kept for callers that only have a total. When `charges` is given this is
   * ignored and the sum of those rows is used instead — one figure, derived
   * from the itemisation rather than able to disagree with it.
   */
  chargesExcl?: number
  /** The same money, itemised and attributable. Preferred over chargesExcl. */
  charges?: ReceiveChargeInput[]
  /**
   * A draft being finalised, rather than a receipt keyed in one go.
   *
   * The draft row is REUSED rather than deleted and re-inserted, so its id
   * survives — anything already pointing at it (an attachment, a link someone
   * sent) still resolves to the posted receipt.
   */
  draftId?: number | null
  /**
   * A discount on the whole delivery — settlement terms, a volume rebate.
   *
   * Apportioned across the lines by value before VAT is worked out, never
   * subtracted from the total: a document-level figure cannot be split by VAT
   * rate, so a mixed-rate delivery would have an unallocatable VAT amount. See
   * rule 3 of documentMath.ts and 092.
   */
  discountPct?: number
  /** An absolute discount on the whole delivery. Wins over the percentage. */
  discountExcl?: number
  /**
   * What the supplier's invoice says the whole delivery comes to, INCLUSIVE
   * of VAT — the figure printed at the bottom of the page in their hand.
   *
   * When given, the receipt is REFUSED if the keyed lines do not tie to it
   * within the site's tolerance. That is the single best guard in the module:
   * a transposed 91 for 19, a line keyed twice, a case cost entered as a unit
   * cost — all of them reach the ledger silently otherwise, and are found when
   * the supplier queries the payment weeks later.
   *
   * Optional, because receiving against a delivery note with no prices on it
   * is a real and common case.
   */
  supplierInvoiceTotal?: number | null
  reference?: string | null
  notes?: string | null
  lines: ReceiveLineInput[]
}

export type ReceiveResult =
  | { ok: true; documentId: number; documentNumber: string; totalExcl: number }
  | { ok: false; error: string }

/**
 * The charge total this receipt will post.
 *
 * When rows are given they are the truth and chargesExcl is ignored — one
 * figure derived from the itemisation, rather than two that can disagree about
 * what the delivery cost.
 */
export function chargesTotalFor(input: ReceiveInput): number {
  if (input.charges && input.charges.length > 0) {
    return round(
      input.charges.reduce((sum, c) => sum + round(c.amountExcl, 2), 0),
      2,
    )
  }
  return round(input.chargesExcl ?? 0, 2)
}

/**
 * The shelf price a line carries, ready for the column — or NULL (193).
 *
 * The NULL is the whole point and is preserved rather than coalesced to 0:
 * "the buyer did not touch this price" and "the buyer set this price to zero"
 * are different instructions, and only the second should move a shelf.
 */
function sellingPriceParam(line: ReceiveLineInput): string | null {
  return line.sellingPriceIncl == null ? null : round(line.sellingPriceIncl, 4).toFixed(4)
}

export function validateReceive(input: ReceiveInput): string | null {
  if (input.lines.length === 0) return 'Add at least one line.'
  if ((input.chargesExcl ?? 0) < 0) return 'Charges cannot be negative.'
  if ((input.discountExcl ?? 0) < 0) return 'A discount cannot be negative.'
  if ((input.discountPct ?? 0) < 0 || (input.discountPct ?? 0) > 100) {
    return 'The discount must be between 0 and 100 percent.'
  }

  for (const [index, charge] of (input.charges ?? []).entries()) {
    const where = `Charge ${index + 1}`
    if (!charge.description?.trim()) return `${where}: say what it is for.`
    if (!Number.isFinite(charge.amountExcl) || charge.amountExcl < 0) {
      return `${where}: the amount cannot be negative.`
    }
    // A charge billed by someone else with no amount is a row that will post an
    // empty invoice to their account. Refused rather than silently skipped.
    if (charge.supplierId && charge.amountExcl <= 0) {
      return `${where}: a charge on another supplier's account needs an amount.`
    }
  }

  for (const [index, line] of input.lines.entries()) {
    const where = `Line ${index + 1}`
    if (!line.description?.trim()) return `${where}: a description is required.`
    if (!Number.isFinite(line.qtyReceived) || line.qtyReceived <= 0) {
      return `${where}: enter how many arrived.`
    }
    if (!Number.isFinite(line.unitCostExcl) || line.unitCostExcl < 0) {
      return `${where}: the cost cannot be negative.`
    }
    if ((line.discountPct ?? 0) < 0 || (line.discountPct ?? 0) > 100) {
      return `${where}: discount must be between 0 and 100 percent.`
    }
    if (!Number.isFinite(line.qtyBonus ?? 0) || (line.qtyBonus ?? 0) < 0) {
      return `${where}: free units cannot be negative.`
    }
    // A shelf price, when the buyer set one (193). NULL is the ordinary case
    // and means "leave it alone" — only a value present is checked, so a
    // delivery nobody re-priced cannot be refused by a pricing rule.
    if (line.sellingPriceIncl != null) {
      if (!Number.isFinite(line.sellingPriceIncl) || line.sellingPriceIncl < 0) {
        return `${where}: the selling price cannot be negative.`
      }
    }

    // Checked here as well as inside the transaction. This catches the mistake
    // before any work starts and names the line by number; the transaction
    // check is the one that cannot be bypassed by a caller that skips
    // validateReceive, and it is also the only one holding a lock.
    if (line.productId && (line.productType ?? 'normal') === 'serial') {
      const serials = (line.serials ?? []).map((s) => s.trim()).filter(Boolean)
      // Against the TOTAL arriving, bonus included: a free phone is still a
      // phone with an IMEI, and counting only the paid units would let it enter
      // stock unserialised.
      const arriving = round(line.qtyReceived + (line.qtyBonus ?? 0), 3)
      if (!Number.isInteger(arriving)) {
        return `${where}: a serial-tracked product must be received in whole units.`
      }
      if (serials.length !== arriving) {
        return `${where}: ${arriving} arrived but ${serials.length} serial number${
          serials.length === 1 ? ' was' : 's were'
        } entered. Every unit needs one.`
      }
      if (new Set(serials).size !== serials.length) {
        return `${where}: the same serial number is entered twice.`
      }
    }

    // A batch line needs its lot data NOW, for the same reason a serial line
    // does: the delivery note leaves with the driver.
    if (line.productId && (line.productType ?? 'normal') === 'batch') {
      if (!line.batchNo?.trim() && !line.expiryDate?.trim()) {
        return `${where}: a batch-tracked product needs its lot number or expiry date to be received.`
      }
      if (line.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(line.expiryDate)) {
        return `${where}: write the expiry as a date, like 2027-03-31.`
      }
    }
  }
  return null
}

/* ── Drafts ──────────────────────────────────────────────────────────────── */

export type DraftResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Saves a receipt WITHOUT posting it.
 *
 * A delivery is not always keyable in one sitting: half the pallet is checked,
 * the driver needs signing out, a price is queried with the supplier, the phone
 * goes. Until now the only options were to finish or to lose the lot, and on a
 * sixty-line delivery that is an hour of work standing on one interruption.
 *
 * ── WHAT A DRAFT DELIBERATELY DOES NOT DO ────────────────────────────────
 *
 * NOTHING. No stock, no cost, no ledger, no number — exactly like a purchase
 * order, and for the same reason: none of it has been agreed yet. Everything
 * that actually happens lives in receiveGoods(), and a draft is only a
 * remembered keystroke set.
 *
 * That is why this is a separate function rather than a flag on receiveGoods:
 * a posting path with an "actually, do not post" branch is one bad condition
 * away from moving stock for a document nobody finished.
 *
 * ── AND WHY IT VALIDATES ALMOST NOTHING ──────────────────────────────────
 *
 * A draft is by definition incomplete. Refusing to save one because a quantity
 * is still zero, or a serial has not been scanned, defeats the whole point —
 * the receiver saved it precisely BECAUSE they had not got to that yet. The
 * full validation runs at finalise, where it belongs. Only a supplier is
 * required, because the row cannot exist without one.
 *
 * Lines are rewritten wholesale, as saveOrder does: nothing has been received,
 * so there is no state to preserve.
 */
export async function saveDraftReceipt(
  siteId: number,
  actor: Actor,
  input: ReceiveInput,
  documentId?: number,
): Promise<DraftResult> {
  if (!input.supplierId) return { ok: false, error: 'Choose who this delivery came from.' }

  // The supplier file may be the group's; the receipt is always this shop's.
  const supplier = await supplierQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    'SELECT id, code, name, status FROM suppliers WHERE id = ? LIMIT 1',
    [input.supplierId],
  )
  if (!supplier) return { ok: false, error: 'That supplier no longer exists.' }
  if (String(supplier.status) === 'closed') {
    return { ok: false, error: `${supplier.name}'s account is closed.` }
  }

  if (documentId) {
    const existing = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
      siteId,
      "SELECT id, status, doc_type FROM purchase_documents WHERE id = ? LIMIT 1",
      [documentId],
    )
    if (!existing) return { ok: false, error: 'That receipt no longer exists.' }
    if (String(existing.doc_type) !== 'grv') {
      return { ok: false, error: 'That document is not a goods receipt.' }
    }
    // The important refusal. A finalised GRV has moved stock and credited a
    // supplier; rewriting its lines here would leave the document disagreeing
    // with the movements and the ledger it produced, with nothing to say which
    // was right. A posted receipt is corrected by a return or a void.
    if (String(existing.status) !== 'draft') {
      return { ok: false, error: 'That receipt has been posted and cannot be edited.' }
    }
  }

  // Figures are computed so the draft shows sensible totals when reopened, but
  // they are not authoritative — finalise recomputes everything from the lines.
  const docDate = input.documentDate ?? todayIso()
  const lineValues = input.lines.map((line) => {
    const gross = round((line.qtyReceived || 0) * line.unitCostExcl, 2)
    const discount =
      (line.discountAmount ?? 0) > 0
        ? round(Math.min(line.discountAmount ?? 0, gross), 2)
        : round(gross * ((line.discountPct ?? 0) / 100), 2)
    return round(gross - discount, 2)
  })
  const subtotalExcl = lineValues.reduce((sum, v) => round(sum + v, 2), 0)
  const vatTotal = input.lines.reduce(
    (sum, line, i) => round(sum + lineValues[i] * (line.vatRatePct / 100), 2),
    0,
  )
  const chargesExcl = chargesTotalFor(input)

  return siteTransaction(siteId, async (tx) => {
    const hasBonus = await columnExistsTx(tx, 'purchase_document_lines', 'qty_bonus')
    const hasLineDiscountAmount = await columnExistsTx(
      tx,
      'purchase_document_lines',
      'discount_amount',
    )
    // 193. Guarded like the two above: a site that has not reached the
    // migration yet must still be able to put a delivery down.
    const hasSellingPrice = await columnExistsTx(
      tx,
      'purchase_document_lines',
      'selling_price_incl',
    )

    let id = documentId

    if (id) {
      await tx.execute(
        `UPDATE purchase_documents SET
           document_date = ?, supplier_id = ?, supplier_code = ?, supplier_name = ?,
           supplier_invoice_no = ?, subtotal_excl = ?, vat_total = ?, total_incl = ?,
           charges_excl = ?, ordered_from_id = ?, reference = ?, notes = ?
         WHERE id = ?`,
        [
          docDate,
          input.supplierId,
          String(supplier.code),
          String(supplier.name),
          input.supplierInvoiceNo?.trim() || null,
          subtotalExcl.toFixed(4),
          vatTotal.toFixed(4),
          round(subtotalExcl + chargesExcl + vatTotal, 2).toFixed(4),
          chargesExcl.toFixed(4),
          input.orderId ?? null,
          input.reference?.trim() || null,
          input.notes?.trim() || null,
          id,
        ] as never,
      )
      await tx.execute('DELETE FROM purchase_document_lines WHERE document_id = ?', [id] as never)
      if (await tableExistsTx(tx, 'purchase_document_charges')) {
        await tx.execute(
          'DELETE FROM purchase_document_charges WHERE document_id = ?',
          [id] as never,
        )
      }
    } else {
      // No due date and NO NUMBER: both belong to a posted invoice. A draft
      // that consumed a GRV number would leave a hole in the sequence if it
      // were abandoned, and verifySequence would report it forever.
      const [res] = await tx.execute(
        `INSERT INTO purchase_documents
           (doc_type, status, document_date, supplier_id, supplier_code, supplier_name,
            supplier_invoice_no, user_id, user_name, subtotal_excl, vat_total, total_incl,
            charges_excl, ordered_from_id, reference, notes)
         VALUES ('grv','draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          docDate,
          input.supplierId,
          String(supplier.code),
          String(supplier.name),
          input.supplierInvoiceNo?.trim() || null,
          actor.userId,
          actor.userName.slice(0, 120),
          subtotalExcl.toFixed(4),
          vatTotal.toFixed(4),
          round(subtotalExcl + chargesExcl + vatTotal, 2).toFixed(4),
          chargesExcl.toFixed(4),
          input.orderId ?? null,
          input.reference?.trim() || null,
          input.notes?.trim() || null,
        ] as never,
      )
      id = (res as { insertId: number }).insertId
    }

    for (const [index, line] of input.lines.entries()) {
      await tx.execute(
        `INSERT INTO purchase_document_lines
           (document_id, line_number, product_id, location_id, product_code, supplier_code,
            description, product_type, department_id, qty_ordered, qty_received,
            ${hasBonus ? 'qty_bonus, ' : ''}unit_cost_excl, discount_pct,
            ${hasLineDiscountAmount ? 'discount_amount, ' : ''}vat_rate_pct,
            line_total_excl, line_vat, line_total_incl${hasSellingPrice ? ', selling_price_incl' : ''})
         VALUES (?,?,?,?,?,?,?,?,?,?,?,${hasBonus ? '?,' : ''}?,?,${
           hasLineDiscountAmount ? '?,' : ''
         }?,?,?,?${hasSellingPrice ? ',?' : ''})`,
        [
          id,
          index + 1,
          line.productId ?? null,
          line.locationId ?? null,
          line.productCode ?? null,
          line.supplierCode ?? null,
          line.description.trim().slice(0, 190) || 'Line',
          line.productType ?? 'normal',
          line.departmentId ?? null,
          round(line.qtyOrdered ?? line.qtyReceived ?? 0, 3).toFixed(3),
          round(line.qtyReceived || 0, 3).toFixed(3),
          ...(hasBonus ? [round(line.qtyBonus ?? 0, 3).toFixed(3)] : []),
          round(line.unitCostExcl, 4).toFixed(4),
          (line.discountPct ?? 0).toFixed(3),
          ...(hasLineDiscountAmount ? [round(line.discountAmount ?? 0, 4).toFixed(4)] : []),
          line.vatRatePct.toFixed(3),
          lineValues[index].toFixed(4),
          round(lineValues[index] * (line.vatRatePct / 100), 2).toFixed(4),
          round(lineValues[index] * (1 + line.vatRatePct / 100), 2).toFixed(4),
          // Held, NOT applied: a draft moves no stock, no cost and no price.
          // Keeping it means a delivery keyed on Friday and posted on Monday
          // does not lose the pricing decisions made with the note in hand.
          ...(hasSellingPrice ? [sellingPriceParam(line)] : []),
        ] as never,
      )
    }

    const charges = input.charges ?? []
    if (charges.length > 0 && (await tableExistsTx(tx, 'purchase_document_charges'))) {
      for (const charge of charges) {
        await tx.execute(
          `INSERT INTO purchase_document_charges
             (document_id, supplier_id, description, amount_excl, vat_rate_pct, their_invoice_no)
           VALUES (?,?,?,?,?,?)`,
          [
            id,
            charge.supplierId ?? null,
            charge.description.trim().slice(0, 120) || 'Delivery',
            round(charge.amountExcl, 4).toFixed(4),
            (charge.vatRatePct ?? 0).toFixed(3),
            charge.theirInvoiceNo?.trim() || null,
          ] as never,
        )
      }
    }

    return { ok: true as const, id: id! }
  })
}

/**
 * Throws away a draft receipt.
 *
 * DELETE rather than a cancelled status, unlike an order: an order that was
 * issued and then abandoned is a fact about the supplier relationship worth
 * keeping. A half-keyed delivery that was never posted is not history — it is
 * an unfinished form, and leaving cancelled shells in the purchasing list makes
 * the list worse.
 *
 * Refuses anything finalised, for the obvious reason.
 */
export async function deleteDraftReceipt(
  siteId: number,
  documentId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const doc = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    'SELECT id, status, doc_type FROM purchase_documents WHERE id = ? LIMIT 1',
    [documentId],
  )
  if (!doc) return { ok: false, error: 'That receipt no longer exists.' }
  if (String(doc.doc_type) !== 'grv') return { ok: false, error: 'That is not a goods receipt.' }
  if (String(doc.status) !== 'draft') {
    return { ok: false, error: 'Only a draft can be discarded. A posted receipt is voided.' }
  }

  // Lines and charges cascade from the document — see 017 and 088.
  await siteExecute(siteId, 'DELETE FROM purchase_documents WHERE id = ?', [documentId])
  return { ok: true }
}

export async function receiveGoods(
  siteId: number,
  actor: Actor,
  input: ReceiveInput,
): Promise<ReceiveResult> {
  const invalid = validateReceive(input)
  if (invalid) return { ok: false, error: invalid }

  const supplier = await supplierQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    'SELECT id, code, name, status, payment_terms_days FROM suppliers WHERE id = ? LIMIT 1',
    [input.supplierId],
  )
  if (!supplier) return { ok: false, error: 'That supplier no longer exists.' }
  if (String(supplier.status) === 'closed') {
    return { ok: false, error: `${supplier.name}'s account is closed.` }
  }

  const docDate = input.documentDate ?? todayIso()
  const lockRefusal = await guardPosting(siteId, docDate, 'purchases')
  if (lockRefusal) return { ok: false, error: lockRefusal }

  // Line values BEFORE charges, so the apportionment has something to weight by.
  // The absolute amount wins over the percentage — see 087.
  const lineValues = input.lines.map((line) => {
    const gross = round(line.qtyReceived * line.unitCostExcl, 2)
    const discount =
      (line.discountAmount ?? 0) > 0
        ? round(Math.min(line.discountAmount ?? 0, gross), 2)
        : round(gross * ((line.discountPct ?? 0) / 100), 2)
    return round(gross - discount, 2)
  })

  const subtotalBeforeDocDiscount = lineValues.reduce((sum, v) => round(sum + v, 2), 0)

  // THE DOCUMENT DISCOUNT, apportioned onto the lines rather than taken off the
  // total. Rule 3 of documentMath.ts: a document-level figure cannot be split
  // by VAT rate, so a mixed-rate delivery would have an unallocatable VAT
  // amount. Capped at the subtotal — a discount larger than the goods would
  // produce negative lines and a credit nobody asked for.
  const requestedDiscount =
    (input.discountExcl ?? 0) > 0
      ? round(input.discountExcl ?? 0, 2)
      : round(subtotalBeforeDocDiscount * ((input.discountPct ?? 0) / 100), 2)
  const documentDiscount = round(
    Math.min(Math.max(requestedDiscount, 0), subtotalBeforeDocDiscount),
    2,
  )
  const discountShares = apportionDiscount(lineValues, documentDiscount)

  // What each line is actually worth once BOTH discounts have come off. This is
  // what VAT is charged on, and what freight is weighted by.
  const taxableValues = lineValues.map((v, i) => round(v - discountShares[i], 2))

  // EVERY charge lands in cost, whoever billed it — the goods cost what they
  // cost to get onto the shelf. Spread pro-rata by value: a flat split per line
  // would load a R5 packet of seasoning with the same delivery cost as a R900
  // case of stock.
  //
  // Weighted by the DISCOUNTED value, and apportioned AFTER the discount:
  // freight is not reduced by the goods supplier's settlement terms, but a line
  // that is now worth less should carry proportionally less of the delivery.
  const chargesTotal = chargesTotalFor(input)
  const charges = apportionDiscount(taxableValues, chargesTotal)

  // The credit side is where they part company. A charge with no supplier is
  // on the goods invoice, exactly as before; one with a supplier is a separate
  // creditor and must not inflate what the goods supplier is owed.
  const chargeRows = input.charges ?? []
  const ownCharges = round(
    chargeRows.filter((c) => !c.supplierId).reduce((s, c) => s + round(c.amountExcl, 2), 0),
    2,
  )
  // No itemisation at all means the whole total is the goods supplier's, which
  // is what chargesExcl has always meant.
  const goodsSupplierCharges = chargeRows.length > 0 ? ownCharges : chargesTotal
  const thirdPartyCharges = chargeRows.filter((c) => c.supplierId && c.amountExcl > 0)

  const computed = input.lines.map((line, index) => {
    // Net of BOTH discounts. VAT is charged on this, and it is what the line
    // stores — a GRV line should read what that line actually cost.
    const netExcl = taxableValues[index]
    const chargeExcl = charges[index]
    const vat = round(netExcl * (line.vatRatePct / 100), 2)
    // Everything that arrived, paid for or not. This is what enters stock and
    // what the cost is spread over.
    const qtyArriving = round(line.qtyReceived + (line.qtyBonus ?? 0), 3)

    return {
      netExcl,
      chargeExcl,
      vat,
      incl: round(netExcl + vat, 2),
      qtyArriving,
      // What the item actually cost to get onto the shelf. Pricing off the
      // invoice cost alone quietly understates every margin it feeds.
      //
      // Divides by qtyArriving, NOT qtyReceived: bonus units cost nothing but
      // are still units, so 10 paid at 100 with 1 free is 90.9091 each, not
      // 100. Dividing by the paid quantity overstates the cost of every
      // promotional buy — and this figure is what average_cost blends, so the
      // error compounds with each receipt rather than showing up once. See 090.
      landedUnitCost:
        qtyArriving === 0 ? 0 : round((netExcl + chargeExcl) / qtyArriving, 4),
    }
  })

  /*
   * ── RECEIVING A PACK ─────────────────────────────────────────────────────
   *
   * A refer line means one of two things, and the method on the link decides
   * which. See 103_refer_methods.sql.
   *
   *   normal    the pack is real. Ten cases received are ten cases owned, and
   *             the movement below names the case itself. That is what this
   *             loop already did, and it becomes correct by no longer being an
   *             accident.
   *
   *   subtract  the pack is a label on a pile of singles. Ten cases of 24 are
   *             240 singles, and the case carries nothing. Receiving against
   *             the case itself would strand the quantity on a product whose
   *             stockDirectionFor is 0 — nothing could ever sell it down, no
   *             stock take would count it, and it would sit there forever.
   *             THAT IS THE BUG THIS FIXES.
   *
   * resolveComponents() gives the target and the FULL chain factor, so a case
   * that refers to a six-pack that refers to a single resolves straight to 24
   * singles in one step.
   *
   * Resolved before the transaction opens, so a broken refer setup is refused
   * while nothing has moved.
   */
  const exploding = await explodingProducts(
    siteId,
    input.lines.filter((l) => l.productId).map((l) => l.productId as number),
  )

  const composed = new Map<number, ResolvedComponent[]>()
  for (const [index, line] of input.lines.entries()) {
    if (!line.productId) continue
    if (!exploding.has(line.productId)) continue

    const resolved = await resolveComponents(
      siteId,
      line.productId,
      (line.productType ?? 'normal') as ProductTypeId,
    )
    if (!resolved.ok) {
      return { ok: false, error: `${line.description}: ${resolved.error}` }
    }
    composed.set(index, resolved.components)
  }

  const subtotalExcl = computed.reduce((sum, c) => round(sum + c.netExcl, 2), 0)
  const vatTotal = computed.reduce((sum, c) => round(sum + c.vat, 2), 0)
  // The document's charge figure is the WHOLE delivery cost, because that is
  // what was apportioned into landed cost and what the GRV should show.
  const chargesExcl = chargesTotal

  // But the goods supplier is owed only THEIR share. A courier's invoice
  // sitting in this total would be chased from the wrong account, and paid to
  // the wrong company by the payment run.
  const ownChargeVat = round(
    chargeRows
      .filter((c) => !c.supplierId)
      .reduce((s, c) => s + round(round(c.amountExcl, 2) * ((c.vatRatePct ?? 0) / 100), 2), 0),
    2,
  )
  const totalIncl = round(subtotalExcl + goodsSupplierCharges + vatTotal + ownChargeVat, 2)

  // ── DOES IT TIE TO THEIR INVOICE? ────────────────────────────────────────
  //
  // Checked here, after every figure is computed and BEFORE anything is
  // written. A receipt that does not agree with the document it was keyed from
  // is a keying error nine times in ten, and the tenth is a genuine dispute
  // that should be settled with the supplier rather than posted and forgotten.
  //
  // Compared against what the GOODS supplier is owed, not the whole delivery
  // cost: a courier's separate invoice is not on the page being checked.
  if (input.supplierInvoiceTotal !== null && input.supplierInvoiceTotal !== undefined) {
    const claimed = round(input.supplierInvoiceTotal, 2)
    const tolerance = Math.abs(
      toNum(await getSetting(siteId, 'purchase_invoice_tolerance'), 0.1),
    )
    const out = round(totalIncl - claimed, 2)

    if (Math.abs(out) > tolerance) {
      const over = out > 0
      return {
        ok: false,
        error:
          `The lines come to ${totalIncl.toFixed(2)} but their invoice says ` +
          `${claimed.toFixed(2)} — ${Math.abs(out).toFixed(2)} ${over ? 'more' : 'less'} than ` +
          `they are charging. Check the quantities and costs, or the invoice total.`,
      }
    }
  }

  const dueDate = dueDateFor('invoice', docDate, Number(supplier.payment_terms_days ?? 30))

  // Finalising a draft: check it is still a draft BEFORE any work starts.
  // Without this, two people finalising the same draft — or one double-click —
  // would post the stock twice and credit the supplier twice, with two
  // documents claiming to be the same delivery.
  if (input.draftId) {
    const draft = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
      siteId,
      "SELECT id, status, doc_type FROM purchase_documents WHERE id = ? LIMIT 1",
      [input.draftId],
    )
    if (!draft) return { ok: false, error: 'That draft no longer exists.' }
    if (String(draft.doc_type) !== 'grv') {
      return { ok: false, error: 'That document is not a goods receipt.' }
    }
    if (String(draft.status) !== 'draft') {
      return { ok: false, error: 'That receipt has already been posted.' }
    }
  }

  try {
    const posted = await siteTransaction(siteId, async (tx) => {
      // 092 adds the document discount columns. A site it has not reached must
      // still be able to receive: the discount is already apportioned into the
      // lines above, so only the record of WHY the lines are lower is lost.
      const hasDocDiscount = await columnExistsTx(tx, 'purchase_documents', 'discount_excl')

      const values = [
        docDate,
        dueDate,
        input.supplierId,
        String(supplier.code),
        String(supplier.name),
        input.supplierInvoiceNo?.trim() || null,
        actor.userId,
        actor.userName.slice(0, 120),
        subtotalExcl.toFixed(4),
        vatTotal.toFixed(4),
        totalIncl.toFixed(4),
        chargesExcl.toFixed(4),
        ...(hasDocDiscount
          ? [(input.discountPct ?? 0).toFixed(3), documentDiscount.toFixed(4)]
          : []),
        input.orderId ?? null,
        input.reference?.trim() || null,
        input.notes?.trim() || null,
      ]

      let documentId: number

      if (input.draftId) {
        // The draft row BECOMES the receipt, keeping its id: an attachment
        // filed against the draft, or a link someone sent, still resolves to
        // the posted document. Re-checked as a draft inside the transaction —
        // the guard above is outside it, so two finalises racing could both
        // pass there but only one can pass here.
        const [res] = await tx.execute(
          `UPDATE purchase_documents SET
             status = 'finalised', finalised_at = NOW(),
             document_date = ?, due_date = ?, supplier_id = ?, supplier_code = ?,
             supplier_name = ?, supplier_invoice_no = ?, user_id = ?, user_name = ?,
             subtotal_excl = ?, vat_total = ?, total_incl = ?, charges_excl = ?,
             ${hasDocDiscount ? 'discount_pct = ?, discount_excl = ?,' : ''}
             ordered_from_id = ?, reference = ?, notes = ?
           WHERE id = ? AND status = 'draft'`,
          [...values, input.draftId] as never,
        )
        if ((res as { affectedRows: number }).affectedRows === 0) {
          throw new Error('That receipt has already been posted.')
        }
        documentId = input.draftId

        // The draft's own lines and charges go; what follows replaces them.
        await tx.execute(
          'DELETE FROM purchase_document_lines WHERE document_id = ?',
          [documentId] as never,
        )
        if (await tableExistsTx(tx, 'purchase_document_charges')) {
          await tx.execute(
            'DELETE FROM purchase_document_charges WHERE document_id = ?',
            [documentId] as never,
          )
        }
      } else {
        const [res] = await tx.execute(
          `INSERT INTO purchase_documents
             (doc_type, status, document_date, due_date, supplier_id, supplier_code, supplier_name,
              supplier_invoice_no, user_id, user_name, subtotal_excl, vat_total, total_incl,
              charges_excl, ${hasDocDiscount ? 'discount_pct, discount_excl, ' : ''}ordered_from_id, reference, notes)
           VALUES ('grv','finalised',?,?,?,?,?,?,?,?,?,?,?,?,${hasDocDiscount ? '?,?,' : ''}?,?,?)`,
          values as never,
        )
        documentId = (res as { insertId: number }).insertId
      }

      // The itemised charges, so the GRV can say what the delivery cost was
      // made of and who billed each part. Skipped where 088 has not reached
      // this site yet — the total on the document still carries the money, and
      // a receipt must not fail because a migration is queued behind another.
      if (chargeRows.length > 0 && (await tableExistsTx(tx, 'purchase_document_charges'))) {
        for (const charge of chargeRows) {
          await tx.execute(
            `INSERT INTO purchase_document_charges
               (document_id, supplier_id, description, amount_excl, vat_rate_pct, their_invoice_no)
             VALUES (?,?,?,?,?,?)`,
            [
              documentId,
              charge.supplierId ?? null,
              charge.description.trim().slice(0, 120),
              round(charge.amountExcl, 4).toFixed(4),
              (charge.vatRatePct ?? 0).toFixed(3),
              charge.theirInvoiceNo?.trim() || null,
            ] as never,
          )
        }
      }

      // 090 adds qty_bonus. A site it has not reached must still be able to
      // receive — the quantity arriving is what matters for stock and cost, and
      // both are computed above rather than read back from the column.
      const hasBonus = await columnExistsTx(tx, 'purchase_document_lines', 'qty_bonus')
      // 087. Same reasoning — the discount is already in the line's value, so
      // only the record of how it was expressed is lost where it is missing.
      const hasLineDiscountAmount = await columnExistsTx(
        tx,
        'purchase_document_lines',
        'discount_amount',
      )
      // 193, the shelf price the buyer set while pricing the delivery. Same
      // reasoning again: a site the migration has not reached still receives
      // goods, it just does not re-price them.
      const hasSellingPrice = await columnExistsTx(
        tx,
        'purchase_document_lines',
        'selling_price_incl',
      )

      /*
       * The shelf prices this receipt will move, collected as the lines post.
       *
       * Gathered rather than written per line so the whole set goes through
       * writePriceRows ONCE — that helper is the single definition of a price
       * write (144), it batches, and it is what records the before/after in
       * product_price_history. Writing prices here by hand would be the one
       * path in the app whose price changes left no trace.
       */
      const priceRows: PriceRow[] = []

      /*
       * Whose cost this receipt moved, for the refer cascade after the commit.
       *
       * A case of 24 costs 24 singles, so a delivery that reprices the single
       * has repriced every pack drawing on it — but the packs' own stored
       * figures are written nowhere in this loop, and under subtract pack the
       * receipt lands on the base rather than the pack that was keyed. Left
       * alone the case keeps yesterday's cost and reports a margin nobody
       * earned. Collected here and spent below, for the same reason priceRows
       * is: the cascade re-reads what this transaction wrote, so it cannot run
       * until the transaction is committed.
       */
      const costMoved = new Set<number>()

      /*
       * Which price the GRV moves: the DEFAULT structure, resolved once.
       *
       * The same one the receiving grid displays and prices against (see
       * productPositions), so the figure written back is the figure the buyer
       * was looking at. A shop with Wholesale and Online price types keeps
       * those where they are — a delivery re-prices the shelf, and deciding
       * what it does to the other structures is the repricing screen's job,
       * where the rule between them is stated.
       *
       * NULL when a site has no default structure at all. Prices simply do
       * not move then: a GRV must not invent one, and must not fail to receive
       * goods over a pricing setup question.
       */
      const [structureRows] = await tx.query(
        'SELECT id FROM price_structures WHERE is_default = 1 ORDER BY position, id LIMIT 1',
      )
      const defaultPriceStructureId =
        ((structureRows as RowDataPacket[])[0]?.id as number | undefined) ?? null

      for (const [index, line] of input.lines.entries()) {
        const c = computed[index]

        // Resolved once per line, inside the transaction: the movement below
        // and the document line must name the SAME place, or the GRV would
        // print a destination the stock never went to.
        const locationId = line.locationId ?? (await mainLocationIdTx(tx))

        await tx.execute(
          `INSERT INTO purchase_document_lines
             (document_id, line_number, product_id, location_id, product_code, supplier_code, description,
              product_type, department_id, qty_ordered, qty_received, ${hasBonus ? 'qty_bonus, ' : ''}unit_cost_excl,
              discount_pct, ${hasLineDiscountAmount ? 'discount_amount, ' : ''}vat_rate_pct,
              line_total_excl, line_vat, line_total_incl, charge_excl, landed_cost_excl${
                hasSellingPrice ? ', selling_price_incl' : ''
              })
           VALUES (?,?,?,?,?,?,?,?,?,?,?,${hasBonus ? '?,' : ''}?,?,${hasLineDiscountAmount ? '?,' : ''}?,?,?,?,?,?${
             hasSellingPrice ? ',?' : ''
           })`,
          [
            documentId,
            index + 1,
            line.productId ?? null,
            locationId,
            line.productCode ?? null,
            line.supplierCode ?? null,
            line.description.trim().slice(0, 190),
            line.productType ?? 'normal',
            line.departmentId ?? null,
            round(line.qtyOrdered ?? line.qtyReceived, 3).toFixed(3),
            round(line.qtyReceived, 3).toFixed(3),
            ...(hasBonus ? [round(line.qtyBonus ?? 0, 3).toFixed(3)] : []),
            round(line.unitCostExcl, 4).toFixed(4),
            (line.discountPct ?? 0).toFixed(3),
            ...(hasLineDiscountAmount
              ? [round(line.discountAmount ?? 0, 4).toFixed(4)]
              : []),
            line.vatRatePct.toFixed(3),
            c.netExcl.toFixed(4),
            c.vat.toFixed(4),
            c.incl.toFixed(4),
            c.chargeExcl.toFixed(4),
            c.landedUnitCost.toFixed(4),
            // What this line decided the shelf price should be, so the posted
            // GRV can show it beside the cost that justified it.
            ...(hasSellingPrice ? [sellingPriceParam(line)] : []),
          ] as never,
        )

        if (!line.productId) continue

        /*
         * A subtract-pack line puts its TARGET on the shelf, not itself.
         *
         * Ten cases of 24 become 240 singles at a twenty-fourth of the landed
         * cost each. Dividing the cost is not optional: receiving 240 singles
         * at the cost of a case would value the shelf at 24× what was paid and
         * poison every GP figure that touches the product.
         *
         * The document line above still records the CASE — a GRV has to print
         * what the supplier actually delivered.
         */
        const components = composed.get(index)
        if (components) {
          for (const component of components) {
            const qty = round(c.qtyArriving * component.qtyPerUnit, 3)
            if (qty === 0) continue

            const unitCost =
              component.qtyPerUnit === 0
                ? 0
                : round(c.landedUnitCost / component.qtyPerUnit, 4)

            const [beforeComponent] = await tx.execute(
              'SELECT stock_on_hand, average_cost FROM products WHERE id = ? FOR UPDATE',
              [component.productId] as never,
            )
            const componentRow = (beforeComponent as RowDataPacket[])[0]

            await recordMovement(tx, actor, {
              productId: component.productId,
              locationId,
              movementType: 'receipt',
              qtyChange: qty,
              unitCostExcl: unitCost,
              source: 'grv',
              sourceDocId: documentId,
              // Names the pack, so the single's history reads "came in as a
              // case" rather than looking like an unexplained surplus.
              note: `${line.productCode ?? line.description} × ${component.qtyPerUnit}`.slice(0, 190),
            })

            const componentAverage = weightedAverageCost({
              existingQty: toNum(componentRow?.stock_on_hand),
              existingCostExcl: toNum(componentRow?.average_cost),
              receivedQty: qty,
              receivedCostExcl: unitCost,
            })

            await tx.execute(
              'UPDATE products SET average_cost = ?, last_cost = ?, last_purchase_date = NOW() WHERE id = ?',
              [componentAverage.toFixed(4), unitCost.toFixed(4), component.productId] as never,
            )
            costMoved.add(component.productId)
          }

          /*
           * NO PRICE MOVE for a pack line, deliberately (193).
           *
           * The line prices the CASE, but the case never reaches a shelf —
           * its singles do. Pushing a case price onto the single would
           * multiply every shelf price by the pack size, and pushing it onto
           * the case would price a product the till cannot sell. Re-pricing
           * the single from a pack cost is a decision for the pricing screen,
           * where the divisor is visible.
           */

          // Close off the order line this fulfils, then skip the single-product
          // path below — the pack itself holds nothing.
          if (line.orderLineId) {
            await tx.execute(
              'UPDATE purchase_document_lines SET qty_received = qty_received + ? WHERE id = ?',
              [round(line.qtyReceived, 3).toFixed(3), line.orderLineId] as never,
            )
          }
          continue
        }

        // Read the position BEFORE the movement — the average has to blend
        // against what was there, not against what it is about to become.
        const [before] = await tx.execute(
          'SELECT stock_on_hand, average_cost FROM products WHERE id = ? FOR UPDATE',
          [line.productId] as never,
        )
        const current = (before as RowDataPacket[])[0]
        const existingQty = toNum(current?.stock_on_hand)
        const existingCost = toNum(current?.average_cost)

        // The BONUS UNITS GO ON THE SHELF TOO. Moving only the paid quantity
        // would leave the free ones invisible to stock, and the first count
        // would find them as an unexplained surplus.
        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId,
          movementType: 'receipt',
          qtyChange: c.qtyArriving,
          unitCostExcl: c.landedUnitCost,
          source: 'grv',
          sourceDocId: documentId,
          note: input.supplierInvoiceNo ? `Inv ${input.supplierInvoiceNo}` : undefined,
          // The lot identity (148) rides the movement into the batch hook,
          // which creates or tops up the lot in this same transaction.
          batch:
            (line.productType ?? 'normal') === 'batch'
              ? { batchNo: line.batchNo ?? null, expiryDate: line.expiryDate ?? null }
              : undefined,
        })

        // The individual units, in the SAME transaction that just moved the
        // quantity. Either both land or neither does — a receipt that moved
        // three phones but recorded two serials would leave the two figures
        // disagreeing with no way to tell which was right.
        if ((line.productType ?? 'normal') === 'serial') {
          const captured = await receiveSerialsTx(tx, actor, {
            productId: line.productId,
            serials: line.serials ?? [],
            // One per unit ARRIVING — a free phone is still a phone with an
            // IMEI, and the quantity moved above counts it.
            qtyReceived: c.qtyArriving,
            documentId,
            locationId,
            costExcl: c.landedUnitCost,
            warrantyUntil: line.warrantyUntil ?? null,
            lineLabel: line.description.trim() || `Line ${index + 1}`,
          })
          // Thrown, not returned: we are inside the transaction, and the throw
          // is what rolls back the stock movement written moments ago. The
          // catch below turns it back into a refusal for the caller.
          if (!captured.ok) throw new Error(captured.error)
        }

        // THE COST MOVE. Both figures, and only here:
        //   average_cost blends what was there with what arrived
        //   last_cost is simply what we just paid
        // Blended over everything that arrived, at the cost each actually
        // worked out to. Using the paid quantity here with a landed cost that
        // already divided by the arriving one would weight the blend wrongly
        // AND disagree with the stock movement written moments ago.
        const newAverage = weightedAverageCost({
          existingQty,
          existingCostExcl: existingCost,
          receivedQty: c.qtyArriving,
          receivedCostExcl: c.landedUnitCost,
        })

        await tx.execute(
          'UPDATE products SET average_cost = ?, last_cost = ?, last_purchase_date = NOW() WHERE id = ?',
          [newAverage.toFixed(4), c.landedUnitCost.toFixed(4), line.productId] as never,
        )
        costMoved.add(line.productId)

        /*
         * THE PRICE MOVE (193) — queued here, written once after the loop.
         *
         * Only when the buyer actually set a price. The receiving grid seeds
         * every line with the product's CURRENT shelf price so the markup and
         * GP columns have something to read against, which means a line nobody
         * touched arrives here carrying a figure — treating that as an
         * instruction would have every delivery rewrite the shelf from a value
         * that was only ever a starting point, and quietly undo a price change
         * made between the order going out and the goods arriving.
         *
         * The client sends NULL for an untouched line; this is the server-side
         * half of the same rule, so a caller that skips the screen cannot move
         * a price by accident either.
         */
        if (line.sellingPriceIncl != null && defaultPriceStructureId !== null) {
          priceRows.push({
            productId: line.productId,
            priceStructureId: defaultPriceStructureId,
            priceIncl: round(line.sellingPriceIncl, 4),
          })
        }

        // Keep the supplier's own code and cost for this product, so the next
        // order goes out with their reference on it.
        if (line.supplierCode || c.landedUnitCost > 0) {
          await tx.execute(
            `INSERT INTO product_suppliers (product_id, supplier_id, supplier_code, last_cost)
                  VALUES (?,?,?,?)
             ON DUPLICATE KEY UPDATE
               supplier_code = COALESCE(VALUES(supplier_code), supplier_code),
               last_cost     = VALUES(last_cost)`,
            [
              line.productId,
              input.supplierId,
              line.supplierCode?.trim() || null,
              round(line.unitCostExcl, 4).toFixed(4),
            ] as never,
          )
        }

        // Close off the order line this fulfils.
        //
        // The PAID quantity only, deliberately. An order for 100 filled by 90
        // paid plus 10 free is still 10 short of what was ordered: the
        // outstanding figure asks "what am I still waiting for", and a
        // promotional freebie does not answer it. Counting bonus units here
        // would silently close orders that the supplier has not finished.
        if (line.orderLineId) {
          await tx.execute(
            'UPDATE purchase_document_lines SET qty_received = qty_received + ? WHERE id = ?',
            [round(line.qtyReceived, 3).toFixed(3), line.orderLineId] as never,
          )
        }
      }

      /*
       * THE PRICES, once, through the one definition of a price write (193).
       *
       * Inside the receipt's transaction on purpose: a shelf price that moved
       * for a delivery that then failed to post would be charging customers
       * for goods the system says never arrived. Either both land or neither
       * does — the same rule the stock movement and the cost blend follow.
       *
       * writePriceRows takes the transaction rather than opening its own, and
       * writes a product_price_history row per GENUINE change, so a line
       * re-stating the price it already had records nothing.
       */
      if (priceRows.length > 0) {
        await writePriceRows(tx, priceRows, {
          source: 'grv',
          sourceDocId: documentId,
          userName: actor.userName,
        })
      }

      // The number, LAST. See the module comment on lock ordering.
      const documentNumber = await nextDocumentNumber(tx, 'grv')
      await tx.execute(
        'UPDATE purchase_documents SET document_number = ?, finalised_at = NOW() WHERE id = ?',
        [documentNumber, documentId] as never,
      )

      // The audit row rides the same transaction as the status it records —
      // a receipt that finalised without its audit row would defeat the point.
      // Guarded like purchase_document_charges: a site 139 has not reached yet
      // must still be able to receive goods (see the 088 precedent above).
      if (await tableExistsTx(tx, 'purchase_document_audit')) {
        await tx.execute(
          `INSERT INTO purchase_document_audit (document_id, action, detail, user_id, user_name)
           VALUES (?, 'finalised', ?, ?, ?)`,
          [
            documentId,
            `${documentNumber} · ${totalIncl.toFixed(2)} · ${supplier.name}`,
            actor.userId,
            actor.userName.slice(0, 120),
          ] as never,
        )
      }

      // costMoved rides out with the result rather than being hoisted above
      // the transaction: it is only meaningful once these writes committed.
      return { documentId, documentNumber, costMoved: [...costMoved] }
    })

    /*
     * The pack costs above whatever this receipt repriced.
     *
     * After the commit, on the same terms as the GL mirror below: a pack whose
     * derived cost could not be rewritten is a reporting gap, never a reason to
     * un-receive goods that are on the shelf. cascadeReferCosts swallows its
     * own failures for that reason; the catch is belt and braces.
     *
     * It re-reads the base's committed cost, which is why it cannot be done
     * inside the transaction above — it would either deadlock on the rows just
     * written or read the pre-receipt figure and spread that.
     */
    const { cascadeReferCosts } = await import('./referRange')
    for (const productId of posted.costMoved) {
      await cascadeReferCosts(siteId, productId).catch(() => 0)
    }

    // The supplier ledger, after the receipt is safely committed — the same
    // reasoning as a sale. A failure to post there must not un-receive goods
    // that are already on the shelf.
    await postSupplierTransaction(siteId, actor, {
      supplierId: input.supplierId,
      docType: 'invoice',
      amount: totalIncl,
      docDate,
      docNumber: input.supplierInvoiceNo?.trim() || posted.documentNumber,
      reference: posted.documentNumber,
      description: `Goods received ${posted.documentNumber}`,
      vatRatePct: subtotalExcl === 0 ? 0 : round((vatTotal / subtotalExcl) * 100, 3),
      source: 'purchase',
      sourceDocId: posted.documentId,
    })

    // Each freight company gets its OWN invoice on its OWN account. Grouped by
    // supplier so a courier who billed two charges on one delivery is owed one
    // invoice rather than two — the payment run matches an invoice number, and
    // splitting it would make theirs unmatchable.
    //
    // After the goods invoice and on the same terms: already committed, so a
    // failure here is a ledger gap to chase rather than a reason to un-receive
    // goods that are on the shelf.
    for (const [freightSupplierId, group] of groupBySupplier(thirdPartyCharges)) {
      const excl = round(group.reduce((s, c) => s + round(c.amountExcl, 2), 0), 2)
      const vat = round(
        group.reduce((s, c) => s + round(round(c.amountExcl, 2) * ((c.vatRatePct ?? 0) / 100), 2), 0),
        2,
      )
      const theirInvoice = group.find((c) => c.theirInvoiceNo?.trim())?.theirInvoiceNo?.trim()

      await postSupplierTransaction(siteId, actor, {
        supplierId: freightSupplierId,
        docType: 'invoice',
        amount: round(excl + vat, 2),
        docDate,
        // Falls back to OUR GRV number suffixed, so two freight invoices on one
        // receipt cannot collide on the duplicate-number guard.
        docNumber: theirInvoice || `${posted.documentNumber}-F${freightSupplierId}`,
        reference: posted.documentNumber,
        description: `${group.map((c) => c.description.trim()).join(', ')} on ${posted.documentNumber}`,
        vatRatePct: excl === 0 ? 0 : round((vat / excl) * 100, 3),
        source: 'purchase',
        sourceDocId: posted.documentId,
      })
    }

    // The general ledger, on the same terms: debit stock and VAT input, credit
    // creditors. Cannot fail the receipt — the GL is a derived mirror, so a
    // missing journal is a reporting gap rather than a reason to un-receive
    // goods already on the shelf. See 045.
    const { mirrorGrv } = await import('./glPosting')
    await mirrorGrv(siteId, actor, {
      documentId: posted.documentId,
      documentNumber: posted.documentNumber,
      documentDate: docDate,
      isReturn: false,
      supplierId: input.supplierId,
      stockExcl: subtotalExcl,
      vatTotal,
      // Freight billed by someone else is an EXPENSE, not stock value: it is
      // debited to freight-in and credited to that supplier, rather than
      // riding on the goods supplier's entry.
      freight: thirdPartyCharges.map((c) => ({
        supplierId: c.supplierId!,
        excl: round(c.amountExcl, 2),
        vat: round(round(c.amountExcl, 2) * ((c.vatRatePct ?? 0) / 100), 2),
      })),
    })

    // Update the order's fulfilment state once its lines have moved.
    if (input.orderId) await refreshOrderFulfilment(siteId, input.orderId)

    // The bell. This sits inside the try whose catch would report a COMMITTED
    // receipt as failed, which is exactly why notify() swallows its own
    // errors rather than throwing.
    const { notify } = await import('./notifications')
    await notify(siteId, {
      event: 'grv_received',
      audience: 'purchasing.view',
      title: `${posted.documentNumber} received`,
      body: `Goods received — R${round(subtotalExcl + vatTotal, 2).toFixed(2)}, by ${actor.userName}`,
      href: `/purchasing/${posted.documentId}`,
    })

    /*
     * Job part requests waiting on this delivery (162).
     *
     * Purchasing does not learn about jobs to do this — it calls one function
     * that reads its own table and answers on its own terms. The claim is
     * stamped inside that function BEFORE any bell rings, so a dead channel
     * means one missed message rather than one on every receipt for ever.
     *
     * Never throws, for the same reason the bell above never does: this runs
     * after a receipt that has already committed.
     *
     * The ORDER id, not the GRV's — `qty_received` is bumped on the ORDER lines
     * (:951 and :1057), and those are the lines a request points at. Passing
     * posted.documentId here would match nothing and silently notify nobody,
     * which is the shape of bug that looks like a feature nobody uses.
     *
     * A receipt with no order behind it (goods that arrived unordered) has no
     * requests to satisfy, so there is nothing to do.
     */
    if (input.orderId) {
      const { markReceivedForDocument } = await import('./jobPartRequests')
      await markReceivedForDocument(siteId, actor, input.orderId)
    }

    // The outbound mirror of the bell — thin ids-and-totals payload; a
    // subscriber fetches the lines back through /api/v1 with a key.
    const { enqueueEvent } = await import('./webhooks')
    await enqueueEvent(siteId, 'grv.received', {
      documentId: posted.documentId,
      documentNumber: posted.documentNumber,
      supplierId: input.supplierId,
      totalExcl: subtotalExcl,
      vatTotal,
    })

    return {
      ok: true,
      documentId: posted.documentId,
      documentNumber: posted.documentNumber,
      totalExcl: subtotalExcl,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The receipt could not be posted.'
    return { ok: false, error: message }
  }
}

/**
 * Recomputes whether an order is open, part received or done.
 *
 * Derived from the lines rather than set by hand: a status that can disagree
 * with the quantities beneath it is a status nobody can trust.
 */
export async function refreshOrderFulfilment(siteId: number, orderId: number): Promise<void> {
  const row = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT SUM(qty_ordered) AS ordered, SUM(qty_received) AS received
       FROM purchase_document_lines WHERE document_id = ?`,
    [orderId],
  )

  const ordered = toNum(row?.ordered)
  const received = toNum(row?.received)
  const status = received <= 0 ? 'open' : received + 0.0005 >= ordered ? 'received' : 'part_received'

  await siteQuery(
    siteId,
    `INSERT INTO purchase_order_details (document_id, fulfilment_status) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE fulfilment_status = VALUES(fulfilment_status)`,
    [orderId, status],
  )
}

/* ── Void ────────────────────────────────────────────────────────────────── */

export type VoidResult = { ok: true } | { ok: false; error: string }

/**
 * Reverses a GRV received in error — same trading day only.
 *
 * Stock goes back out and the supplier ledger reverses. The average cost is
 * NOT unwound: blending it back out would need the position as it stood before
 * the receipt, and any sale since has already moved on. A costing correction is
 * a deliberate adjustment, not a side effect of a void — pretending otherwise
 * would silently restate stock valuation.
 */
export async function voidReceipt(
  siteId: number,
  actor: Actor,
  documentId: number,
  reason: string,
): Promise<VoidResult> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason.' }

  const doc = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    'SELECT * FROM purchase_documents WHERE id = ? LIMIT 1',
    [documentId],
  )
  if (!doc) return { ok: false, error: 'That document no longer exists.' }
  if (String(doc.status) === 'cancelled') return { ok: false, error: 'That receipt is already void.' }
  if (String(doc.status) !== 'finalised') {
    return { ok: false, error: 'Only a finalised receipt can be voided.' }
  }

  const docDate = String(doc.document_date)
  if (docDate !== todayIso()) {
    return {
      ok: false,
      error: `${doc.document_number} was received on ${docDate}. Raise a supplier return instead.`,
    }
  }
  const voidLockRefusal = await guardPosting(siteId, docDate, 'purchases')
  if (voidLockRefusal) return { ok: false, error: voidLockRefusal }

  // COALESCE, not a plain column: qty_bonus arrives with 090, and a site it
  // has not reached must still be able to void. Selected as one figure so the
  // reversal below cannot accidentally use the paid quantity.
  const bonusPresent = await siteQueryOne<RowDataPacket>(
    siteId,
    `SELECT 1 AS ok FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_document_lines'
        AND COLUMN_NAME = 'qty_bonus' LIMIT 1`,
  )
  const lines = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT id, product_id, location_id, landed_cost_excl,
            qty_received ${bonusPresent ? '+ COALESCE(qty_bonus, 0)' : ''} AS qty_arrived
       FROM purchase_document_lines WHERE document_id = ?`,
    [documentId],
  )

  try {
    await siteTransaction(siteId, async (tx) => {
      // The serials this receipt brought in go back out with the quantity.
      // First, because it can refuse — a unit already sold must not be
      // deleted, and finding that out after the stock has moved would mean
      // rolling back anyway.
      const serials = await removeReceivedSerialsTx(tx, documentId)
      if (!serials.ok) throw new Error(serials.error)

      for (const line of lines) {
        if (!line.product_id) continue
        await recordMovement(tx, actor, {
          productId: Number(line.product_id),
          // Back out of the pile it went INTO, not whichever is main now.
          // Defaulting here would take the stock off the shop floor for goods
          // that were put in the warehouse, breaking both piles at once — and
          // main may even have changed since the receipt was posted.
          locationId: line.location_id === null ? null : Number(line.location_id),
          movementType: 'adjustment',
          // Everything that came in goes back out, bonus units included —
          // otherwise the free stock is stranded on the shelf with no
          // movement behind it, and the next count finds a surplus.
          qtyChange: round(-toNum(line.qty_arrived), 3),
          unitCostExcl: toNum(line.landed_cost_excl),
          source: 'cancelled',
          sourceDocId: documentId,
          note: `Void of ${doc.document_number}`,
          // Back out exactly the lots this receipt created (148). The hook
          // THROWS when a lot has been partly consumed — a supplier return is
          // the honest document then — and the catch below shows the reason.
          batch: { reverseReceiptOfDocId: documentId },
        })
      }

      await tx.execute(
        `UPDATE purchase_documents SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW() WHERE id = ?`,
        [reason.trim().slice(0, 190), documentId] as never,
      )

      if (await tableExistsTx(tx, 'purchase_document_audit')) {
        await tx.execute(
          `INSERT INTO purchase_document_audit (document_id, action, detail, user_id, user_name)
           VALUES (?, 'void', ?, ?, ?)`,
          [
            documentId,
            `${doc.document_number} · ${toNum(doc.total_incl).toFixed(2)} · ${reason.trim().slice(0, 300)}`,
            actor.userId,
            actor.userName.slice(0, 120),
          ] as never,
        )
      }
    })
  } catch (error) {
    // A refusal from the serial check arrives here. Nothing has committed, so
    // the receipt is untouched and the reason can be shown as-is.
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'That receipt could not be voided.',
    }
  }

  // Reverse what we owed them.
  await postSupplierTransaction(siteId, actor, {
    supplierId: Number(doc.supplier_id),
    docType: 'credit_note',
    amount: toNum(doc.total_incl),
    docDate: todayIso(),
    docNumber: `REV-${doc.document_number}`,
    description: `Void of ${doc.document_number} — ${reason.trim()}`,
    source: 'purchase',
    sourceDocId: documentId,
    autoAllocate: true,
  })

  // And EVERY carrier this receipt also invoiced.
  //
  // This is the sharpest edge in the whole feature. A receipt can create more
  // than one creditor invoice; a void that reverses only the goods supplier's
  // leaves the courier's account permanently overstated, with nothing on
  // either document to say so. It would be found, if at all, by someone
  // querying a statement months later.
  //
  // Read outside a transaction and tolerant of the table being absent: on a
  // site where 088 is still queued there are no rows, and nothing to reverse.
  const freightGroups = await freightOwedFor(siteId, documentId)
  for (const [freightSupplierId, owed] of freightGroups) {
    await postSupplierTransaction(siteId, actor, {
      supplierId: freightSupplierId,
      docType: 'credit_note',
      amount: owed,
      docDate: todayIso(),
      // Suffixed per carrier, so two carriers on one receipt cannot collide on
      // the duplicate-number guard and silently drop the second reversal.
      docNumber: `REV-${doc.document_number}-F${freightSupplierId}`,
      description: `Void of ${doc.document_number} — ${reason.trim()}`,
      source: 'purchase',
      sourceDocId: documentId,
      autoAllocate: true,
    })
  }

  return { ok: true }
}

/**
 * What each carrier was invoiced on this receipt, VAT included.
 *
 * Returns nothing where 088 has not reached this site — such a receipt cannot
 * have posted a carrier invoice in the first place, so there is nothing to
 * reverse and an empty map is the correct answer rather than an error.
 */
async function freightOwedFor(
  siteId: number,
  documentId: number,
): Promise<Map<number, number>> {
  const present = await siteQueryOne<RowDataPacket>(
    siteId,
    `SELECT 1 AS ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_document_charges' LIMIT 1`,
  )
  if (!present) return new Map()

  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT supplier_id,
            SUM(amount_excl * (1 + vat_rate_pct / 100)) AS owed
       FROM purchase_document_charges
      WHERE document_id = ? AND supplier_id IS NOT NULL
      GROUP BY supplier_id`,
    [documentId],
  )

  return new Map(rows.map((r) => [Number(r.supplier_id), round(toNum(r.owed), 2)]))
}

/** Charges gathered per freight supplier, so each gets one invoice. */
function groupBySupplier(
  charges: readonly ReceiveChargeInput[],
): Map<number, ReceiveChargeInput[]> {
  const groups = new Map<number, ReceiveChargeInput[]>()
  for (const charge of charges) {
    if (!charge.supplierId) continue
    const list = groups.get(charge.supplierId)
    if (list) list.push(charge)
    else groups.set(charge.supplierId, [charge])
  }
  return groups
}

/**
 * Whether a table has actually reached this site's database.
 *
 * Schema drifts between sites: a file in sql/site/ is only real once the runner
 * has applied it there, and a concurrent migration can block the queue. A
 * receipt must still post while 088 is pending — the charge total is on the
 * document either way, and only the itemisation is lost.
 */
/** As tableExistsTx, for a single column. Same reasoning — see 090. */
async function columnExistsTx(
  tx: PoolConnection,
  table: string,
  column: string,
): Promise<boolean> {
  const [rows] = await tx.execute(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column] as never,
  )
  return (rows as RowDataPacket[]).length > 0
}

async function tableExistsTx(tx: PoolConnection, table: string): Promise<boolean> {
  const [rows] = await tx.execute(
    `SELECT 1 FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table] as never,
  )
  return (rows as RowDataPacket[]).length > 0
}

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}
