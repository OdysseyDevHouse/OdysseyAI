import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { apportionDiscount, weightedAverageCost } from '../documentMath'
import { nextDocumentNumber } from './sequences'
import { recordMovement } from './stockMovements'
import { mainLocationIdTx } from './stockLocations'
import { isPeriodLocked } from './settings'
import { postSupplierTransaction } from './supplierLedger'
import { dueDateFor } from './ledger'
import type { Actor } from './activityLog'

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
  /** Per unit, EXCLUSIVE of VAT — how a supplier invoice is written. */
  unitCostExcl: number
  discountPct?: number
  vatRatePct: number
}

export type ReceiveInput = {
  supplierId: number
  /** The purchase order being received against, if any. */
  orderId?: number | null
  supplierInvoiceNo?: string | null
  documentDate?: string
  /** Freight and the like, spread across the lines so cost is landed cost. */
  chargesExcl?: number
  reference?: string | null
  notes?: string | null
  lines: ReceiveLineInput[]
}

export type ReceiveResult =
  | { ok: true; documentId: number; documentNumber: string; totalExcl: number }
  | { ok: false; error: string }

export function validateReceive(input: ReceiveInput): string | null {
  if (input.lines.length === 0) return 'Add at least one line.'
  if ((input.chargesExcl ?? 0) < 0) return 'Charges cannot be negative.'

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
  }
  return null
}

export async function receiveGoods(
  siteId: number,
  actor: Actor,
  input: ReceiveInput,
): Promise<ReceiveResult> {
  const invalid = validateReceive(input)
  if (invalid) return { ok: false, error: invalid }

  const supplier = await siteQueryOne<RowDataPacket & Record<string, unknown>>(
    siteId,
    'SELECT id, code, name, status, payment_terms_days FROM suppliers WHERE id = ? LIMIT 1',
    [input.supplierId],
  )
  if (!supplier) return { ok: false, error: 'That supplier no longer exists.' }
  if (String(supplier.status) === 'closed') {
    return { ok: false, error: `${supplier.name}'s account is closed.` }
  }

  const docDate = input.documentDate ?? todayIso()
  if (await isPeriodLocked(siteId, docDate)) {
    return { ok: false, error: `The VAT period covering ${docDate} is locked.` }
  }

  // Line values BEFORE charges, so the apportionment has something to weight by.
  const lineValues = input.lines.map((line) => {
    const gross = round(line.qtyReceived * line.unitCostExcl, 2)
    const discount = round(gross * ((line.discountPct ?? 0) / 100), 2)
    return round(gross - discount, 2)
  })

  // Freight spread pro-rata by value. A flat split per line would load a R5
  // packet of seasoning with the same delivery cost as a R900 case of stock.
  const charges = apportionDiscount(lineValues, round(input.chargesExcl ?? 0, 2))

  const computed = input.lines.map((line, index) => {
    const netExcl = lineValues[index]
    const chargeExcl = charges[index]
    const vat = round(netExcl * (line.vatRatePct / 100), 2)

    return {
      netExcl,
      chargeExcl,
      vat,
      incl: round(netExcl + vat, 2),
      // What the item actually cost to get onto the shelf. Pricing off the
      // invoice cost alone quietly understates every margin it feeds.
      landedUnitCost:
        line.qtyReceived === 0
          ? 0
          : round((netExcl + chargeExcl) / line.qtyReceived, 4),
    }
  })

  const subtotalExcl = computed.reduce((sum, c) => round(sum + c.netExcl, 2), 0)
  const vatTotal = computed.reduce((sum, c) => round(sum + c.vat, 2), 0)
  const chargesExcl = round(input.chargesExcl ?? 0, 2)
  const totalIncl = round(subtotalExcl + chargesExcl + vatTotal, 2)

  const dueDate = dueDateFor('invoice', docDate, Number(supplier.payment_terms_days ?? 30))

  try {
    const posted = await siteTransaction(siteId, async (tx) => {
      const [res] = await tx.execute(
        `INSERT INTO purchase_documents
           (doc_type, status, document_date, due_date, supplier_id, supplier_code, supplier_name,
            supplier_invoice_no, user_id, user_name, subtotal_excl, vat_total, total_incl,
            charges_excl, ordered_from_id, reference, notes)
         VALUES ('grv','finalised',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
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
          input.orderId ?? null,
          input.reference?.trim() || null,
          input.notes?.trim() || null,
        ] as never,
      )
      const documentId = (res as { insertId: number }).insertId

      for (const [index, line] of input.lines.entries()) {
        const c = computed[index]

        // Resolved once per line, inside the transaction: the movement below
        // and the document line must name the SAME place, or the GRV would
        // print a destination the stock never went to.
        const locationId = line.locationId ?? (await mainLocationIdTx(tx))

        await tx.execute(
          `INSERT INTO purchase_document_lines
             (document_id, line_number, product_id, location_id, product_code, supplier_code, description,
              product_type, department_id, qty_ordered, qty_received, unit_cost_excl,
              discount_pct, vat_rate_pct, line_total_excl, line_vat, line_total_incl,
              charge_excl, landed_cost_excl)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            round(line.unitCostExcl, 4).toFixed(4),
            (line.discountPct ?? 0).toFixed(3),
            line.vatRatePct.toFixed(3),
            c.netExcl.toFixed(4),
            c.vat.toFixed(4),
            c.incl.toFixed(4),
            c.chargeExcl.toFixed(4),
            c.landedUnitCost.toFixed(4),
          ] as never,
        )

        if (!line.productId) continue

        // Read the position BEFORE the movement — the average has to blend
        // against what was there, not against what it is about to become.
        const [before] = await tx.execute(
          'SELECT stock_on_hand, average_cost FROM products WHERE id = ? FOR UPDATE',
          [line.productId] as never,
        )
        const current = (before as RowDataPacket[])[0]
        const existingQty = toNum(current?.stock_on_hand)
        const existingCost = toNum(current?.average_cost)

        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId,
          movementType: 'receipt',
          qtyChange: round(line.qtyReceived, 3),
          unitCostExcl: c.landedUnitCost,
          source: 'grv',
          sourceDocId: documentId,
          note: input.supplierInvoiceNo ? `Inv ${input.supplierInvoiceNo}` : undefined,
        })

        // THE COST MOVE. Both figures, and only here:
        //   average_cost blends what was there with what arrived
        //   last_cost is simply what we just paid
        const newAverage = weightedAverageCost({
          existingQty,
          existingCostExcl: existingCost,
          receivedQty: line.qtyReceived,
          receivedCostExcl: c.landedUnitCost,
        })

        await tx.execute(
          'UPDATE products SET average_cost = ?, last_cost = ?, last_purchase_date = NOW() WHERE id = ?',
          [newAverage.toFixed(4), c.landedUnitCost.toFixed(4), line.productId] as never,
        )

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
        if (line.orderLineId) {
          await tx.execute(
            'UPDATE purchase_document_lines SET qty_received = qty_received + ? WHERE id = ?',
            [round(line.qtyReceived, 3).toFixed(3), line.orderLineId] as never,
          )
        }
      }

      // The number, LAST. See the module comment on lock ordering.
      const documentNumber = await nextDocumentNumber(tx, 'grv')
      await tx.execute(
        'UPDATE purchase_documents SET document_number = ?, finalised_at = NOW() WHERE id = ?',
        [documentNumber, documentId] as never,
      )

      return { documentId, documentNumber }
    })

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

    // Update the order's fulfilment state once its lines have moved.
    if (input.orderId) await refreshOrderFulfilment(siteId, input.orderId)

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
  if (String(doc.status) === 'void') return { ok: false, error: 'That receipt is already void.' }
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
  if (await isPeriodLocked(siteId, docDate)) {
    return { ok: false, error: 'That VAT period is locked.' }
  }

  const lines = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    'SELECT id, product_id, location_id, qty_received, landed_cost_excl FROM purchase_document_lines WHERE document_id = ?',
    [documentId],
  )

  await siteTransaction(siteId, async (tx) => {
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
        qtyChange: round(-toNum(line.qty_received), 3),
        unitCostExcl: toNum(line.landed_cost_excl),
        source: 'void',
        sourceDocId: documentId,
        note: `Void of ${doc.document_number}`,
      })
    }

    await tx.execute(
      `UPDATE purchase_documents SET status = 'void', void_reason = ?, voided_at = NOW() WHERE id = ?`,
      [reason.trim().slice(0, 190), documentId] as never,
    )
  })

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

  return { ok: true }
}

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}
