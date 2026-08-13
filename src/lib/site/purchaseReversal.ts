import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { nextDocumentNumber } from './sequences'
import { recordMovement } from './stockMovements'
import { guardPosting } from './periodLocks'
import { postSupplierTransaction } from './supplierLedger'
import { returnSerialsToSupplierTx } from './serials'
import { getPurchaseDocument } from './purchaseDocuments'
import type { Actor } from './activityLog'
import type { ProductTypeId } from '../productTypes'
import {
  explodingProducts,
  resolveComponents,
  type ResolvedComponent,
} from './productComposition'

/**
 * Supplier returns — sending goods back after the day they were received.
 *
 * The exact mirror of a credit note, and the same distinction applies. VOIDING a
 * GRV (purchasePosting.ts) says the receipt should never have existed and is
 * only possible on the trading day it happened. A SUPPLIER RETURN says the
 * goods really did arrive and are now going back — faulty, over-supplied, wrong
 * item — and is the correct instrument once the day has been closed. The two
 * are different documents in the eyes of a VAT return, and different here too.
 *
 * ── WHAT A RETURN IS ─────────────────────────────────────────────────────
 *
 * Its own document, its own number from the SRT sequence, linked to the GRV
 * through `reverses_id`. Never an edit of the receipt: the supplier's invoice
 * matched that GRV, and it must keep saying what it said.
 *
 * ── THE COST RULE ────────────────────────────────────────────────────────
 *
 * Lines return at the GRV's LANDED cost, copied from the original line and
 * never re-read from the product. Returning at today's average would credit
 * back a figure that was never paid, and every landed-cost calculation
 * downstream would drift.
 *
 * ── WHAT IS DELIBERATELY NOT DONE ────────────────────────────────────────
 *
 * average_cost is NOT unwound, exactly as it is not on a void. Blending it back
 * out needs the position as it stood at receipt, and anything sold since has
 * already moved on at the blended figure. A costing correction is a deliberate
 * adjustment, not a side effect — pretending otherwise silently restates stock
 * valuation.
 */

type Row = RowDataPacket & Record<string, unknown>

export type ReturnLineInput = {
  /** The GRV line going back. */
  sourceLineId: number
  productId: number | null
  productCode?: string | null
  supplierCode?: string | null
  description: string
  productType?: string
  departmentId?: number | null
  /** Positive. The caller says "return 2", and the sign is applied here. */
  qtyReturned: number
  /** Landed cost from the GRV line — what we actually paid to get it here. */
  unitCostExcl: number
  vatRatePct: number
  /** Which pile it leaves. Defaults to the location the GRV line went into. */
  locationId?: number | null
  /** For a serial product: exactly which units are going back. */
  serialIds?: number[]
}

export type SupplierReturnInput = {
  /** The GRV being returned against. */
  grvId: number
  reason: string
  /** Their credit note number, once they issue one. */
  supplierCreditNo?: string | null
  notes?: string | null
  lines: ReturnLineInput[]
}

export type SupplierReturnResult =
  | { ok: true; documentId: number; documentNumber: string; totalExcl: number }
  | { ok: false; error: string }

/**
 * How much of each GRV line has already gone back.
 *
 * Summed across every finalised return pointing at this GRV, so returning the
 * same line twice cannot exceed what was received. Keyed by the ORIGINAL line
 * id, which is why return lines carry `sourceLineId`.
 */
export async function returnedQtyByLine(
  siteId: number,
  grvId: number,
): Promise<Map<number, number>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.source_line_id, SUM(ABS(l.qty_received)) AS returned
       FROM purchase_document_lines l
       JOIN purchase_documents d ON d.id = l.document_id
      WHERE d.reverses_id = ?
        AND d.doc_type = 'supplier_return'
        AND d.status = 'finalised'
        AND l.source_line_id IS NOT NULL
      GROUP BY l.source_line_id`,
    [grvId],
  )

  const byLine = new Map<number, number>()
  for (const row of rows) byLine.set(Number(row.source_line_id), toNum(row.returned))
  return byLine
}

/** What may still be sent back on each line of a GRV. */
export async function returnableLines(siteId: number, grvId: number) {
  const [grv, returned] = await Promise.all([
    getPurchaseDocument(siteId, grvId),
    returnedQtyByLine(siteId, grvId),
  ])
  if (!grv || grv.docType !== 'grv') return null

  return grv.lines.map((line) => {
    const already = returned.get(line.id) ?? 0
    return {
      ...line,
      alreadyReturned: already,
      // Against what ARRIVED, bonus included: a free unit is physically on the
      // shelf and can be faulty like any other, so it must be returnable. It
      // carries a landed cost of its own, so the credit is still right.
      returnable: round(Math.max(line.qtyArrived - already, 0), 3),
    }
  })
}

/** Returns raised against a GRV, for its detail screen. */
export async function returnsFor(siteId: number, grvId: number) {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, document_number, document_date, total_incl, internal_note
       FROM purchase_documents
      WHERE reverses_id = ? AND doc_type = 'supplier_return'
      ORDER BY id`,
    [grvId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date),
    total: toNum(r.total_incl),
    reason: (r.internal_note as string | null) ?? null,
  }))
}

export async function createSupplierReturn(
  siteId: number,
  actor: Actor,
  input: SupplierReturnInput,
): Promise<SupplierReturnResult> {
  if (!input.reason?.trim()) return { ok: false, error: 'Give a reason for the return.' }
  if (input.lines.length === 0) return { ok: false, error: 'Choose at least one line to return.' }

  const grv = await getPurchaseDocument(siteId, input.grvId)
  if (!grv) return { ok: false, error: 'That receipt no longer exists.' }
  if (grv.docType !== 'grv') return { ok: false, error: 'Only a goods receipt can be returned.' }
  if (grv.status !== 'finalised') {
    return { ok: false, error: `A ${grv.status} receipt cannot be returned against.` }
  }

  // Dated today, so a locked PAST period does not block a return raised now —
  // that is the whole point of returning rather than voiding.
  const docDate = todayIso()
  const lockRefusal = await guardPosting(siteId, docDate, 'purchases')
  if (lockRefusal) return { ok: false, error: lockRefusal }

  // Guard against returning more than was received, across ALL returns on this
  // GRV rather than just this one.
  const returned = await returnedQtyByLine(siteId, input.grvId)
  for (const line of input.lines) {
    if (!Number.isFinite(line.qtyReturned) || line.qtyReturned <= 0) {
      return { ok: false, error: `${line.description}: enter how many are going back.` }
    }

    const original = grv.lines.find((l) => l.id === line.sourceLineId)
    if (!original) return { ok: false, error: `A line on that receipt no longer exists.` }

    const already = returned.get(original.id) ?? 0
    const remaining = round(original.qtyReceived - already, 3)
    if (line.qtyReturned > remaining + 0.0005) {
      return {
        ok: false,
        error: `${original.description}: only ${remaining} left to return (${already} already returned of ${original.qtyReceived}).`,
      }
    }

    // Checked up front as well as in the transaction, so the mistake is named
    // before any work begins. The transaction check is the one holding a lock.
    if (line.productId && (line.productType ?? 'normal') === 'serial') {
      const ids = line.serialIds ?? []
      if (!Number.isInteger(line.qtyReturned)) {
        return {
          ok: false,
          error: `${original.description}: a serial-tracked product must be returned in whole units.`,
        }
      }
      if (ids.length !== line.qtyReturned) {
        return {
          ok: false,
          error: `${original.description}: returning ${line.qtyReturned} but ${ids.length} unit${
            ids.length === 1 ? ' was' : 's were'
          } chosen. Pick exactly which ones are going back.`,
        }
      }
    }
  }

  // Values EXCLUSIVE of VAT throughout, matching how a supplier invoice is
  // written and how the GRV stored them.
  const computed = input.lines.map((line) => {
    const netExcl = round(line.qtyReturned * line.unitCostExcl, 2)
    const vat = round(netExcl * (line.vatRatePct / 100), 2)
    return { netExcl, vat, incl: round(netExcl + vat, 2) }
  })

  const subtotalExcl = computed.reduce((sum, c) => round(sum + c.netExcl, 2), 0)
  const vatTotal = computed.reduce((sum, c) => round(sum + c.vat, 2), 0)
  const totalIncl = round(subtotalExcl + vatTotal, 2)

  if (totalIncl <= 0) return { ok: false, error: 'A return must be worth more than nothing.' }

  /*
   * The mirror of the receipt's explosion. A subtract-pack case went onto the
   * shelf as 24 singles, so returning it has to take 24 singles off — sending
   * the case back would deduct a pile that never existed and leave the singles
   * behind. Same definition as purchasePosting, so the two can never disagree
   * about what a pack means.
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

  try {
    const posted = await siteTransaction(siteId, async (tx) => {
      const [res] = await tx.execute(
        `INSERT INTO purchase_documents
           (doc_type, status, document_date, supplier_id, supplier_code, supplier_name,
            supplier_invoice_no, user_id, user_name, subtotal_excl, vat_total, total_incl,
            charges_excl, reverses_id, reference, notes, internal_note)
         VALUES ('supplier_return','finalised',?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
        [
          docDate,
          grv.supplierId,
          grv.supplierCode,
          grv.supplierName,
          input.supplierCreditNo?.trim() || null,
          actor.userId,
          actor.userName.slice(0, 120),
          // Negative throughout: the document is a reduction, so every
          // aggregate stays a plain SUM with no CASE on doc_type.
          (-subtotalExcl).toFixed(4),
          (-vatTotal).toFixed(4),
          (-totalIncl).toFixed(4),
          input.grvId,
          grv.documentNumber,
          input.notes?.trim() || `Return of ${grv.documentNumber}`,
          input.reason.trim().slice(0, 400),
        ] as never,
      )
      const documentId = (res as { insertId: number }).insertId

      for (const [index, line] of input.lines.entries()) {
        const c = computed[index]
        const original = grv.lines.find((l) => l.id === line.sourceLineId)
        const locationId = line.locationId ?? original?.locationId ?? null

        await tx.execute(
          `INSERT INTO purchase_document_lines
             (document_id, line_number, product_id, location_id, product_code, supplier_code,
              description, product_type, department_id, qty_ordered, qty_received,
              unit_cost_excl, discount_pct, vat_rate_pct, line_total_excl, line_vat,
              line_total_incl, charge_excl, landed_cost_excl, source_line_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,0,?,?)`,
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
            round(-line.qtyReturned, 3).toFixed(3),
            round(-line.qtyReturned, 3).toFixed(3),
            round(line.unitCostExcl, 4).toFixed(4),
            line.vatRatePct.toFixed(3),
            (-c.netExcl).toFixed(4),
            (-c.vat).toFixed(4),
            (-c.incl).toFixed(4),
            round(line.unitCostExcl, 4).toFixed(4),
            line.sourceLineId,
          ] as never,
        )

        if (!line.productId) continue

        // A subtract-pack line takes its TARGET back off the shelf, at the
        // per-unit cost the receipt put it on at. Returning one case of 24
        // removes 24 singles.
        const components = composed.get(index)
        if (components) {
          for (const component of components) {
            const qty = round(line.qtyReturned * component.qtyPerUnit, 3)
            if (qty === 0) continue

            await recordMovement(tx, actor, {
              productId: component.productId,
              locationId,
              movementType: 'adjustment',
              qtyChange: -qty,
              unitCostExcl:
                component.qtyPerUnit === 0
                  ? 0
                  : round(line.unitCostExcl / component.qtyPerUnit, 4),
              source: 'supplier_return',
              sourceDocId: documentId,
              note: `Return of ${grv.documentNumber} × ${component.qtyPerUnit}`.slice(0, 190),
            })
          }
          continue
        }

        // Stock leaves the pile it was received into. Defaulting to main would
        // take it off the shop floor for goods sitting in the warehouse,
        // breaking both piles at once.
        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId,
          movementType: 'adjustment',
          qtyChange: round(-line.qtyReturned, 3),
          unitCostExcl: line.unitCostExcl,
          source: 'supplier_return',
          sourceDocId: documentId,
          note: `Return of ${grv.documentNumber}`,
        })

        // The specific units going back, in the SAME transaction as the
        // quantity — the invariant that in-stock serials equal stock on hand
        // holds only if the two can never commit separately.
        if ((line.productType ?? 'normal') === 'serial') {
          const sent = await returnSerialsToSupplierTx(tx, actor, {
            productId: line.productId,
            serialIds: line.serialIds ?? [],
            qtyReturned: line.qtyReturned,
            documentId,
            note: `Return of ${grv.documentNumber} — ${input.reason.trim()}`.slice(0, 190),
            lineLabel: line.description.trim() || `Line ${index + 1}`,
          })
          // Thrown, not returned: we are inside the transaction, and the throw
          // is what rolls back the movement written moments ago.
          if (!sent.ok) throw new Error(sent.error)
        }
      }

      // The number LAST, for the same lock-ordering reason as every other
      // document: claiming it takes an exclusive lock held until commit.
      const documentNumber = await nextDocumentNumber(tx, 'supplier_return')
      await tx.execute(
        'UPDATE purchase_documents SET document_number = ?, finalised_at = NOW() WHERE id = ?',
        [documentNumber, documentId] as never,
      )

      return { documentId, documentNumber }
    })

    // The ledger, after the goods have safely left. A failure to post here must
    // not un-return stock that is already on its way back to the supplier.
    //
    // 'credit_note' is ledger vocabulary, not purchasing vocabulary — the same
    // type a void posts. On a CREDITOR's account it reduces what we owe, which
    // is exactly what sending goods back does, whatever the paperwork is called.
    await postSupplierTransaction(siteId, actor, {
      supplierId: grv.supplierId,
      docType: 'credit_note',
      amount: totalIncl,
      docDate,
      docNumber: input.supplierCreditNo?.trim() || posted.documentNumber,
      reference: posted.documentNumber,
      description: `Return of ${grv.documentNumber} — ${input.reason.trim()}`,
      vatRatePct: subtotalExcl === 0 ? 0 : round((vatTotal / subtotalExcl) * 100, 3),
      source: 'purchase',
      sourceDocId: posted.documentId,
      // No reversesId: on the ledger that column points at another LEDGER
      // transaction, not at a purchase document. The link back to the GRV is
      // purchase_documents.reverses_id, which is where it belongs.
      //
      // Applies against the oldest open invoice, which is what a supplier
      // credit is expected to do.
      autoAllocate: true,
    })

    return {
      ok: true,
      documentId: posted.documentId,
      documentNumber: posted.documentNumber,
      totalExcl: subtotalExcl,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The return could not be posted.'
    return { ok: false, error: message }
  }
}

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}
