import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { customerDbPrefix } from './customerDb'
import { round, toNum } from '../decimals'
import { lineTotals } from '../documentMath'
import { logActivityTx, type Actor } from './activityLog'
import { BILLABLE_STATES, isBillable, type BillingState } from '../jobStatusModel'
import { releaseLine, reserveForQuote, acceptedQuoteFor } from './jobReservations'

/**
 * Billing a job.
 *
 * ── A JOB NEVER POSTS ──────────────────────────────────────────────────────
 *
 * This raises a DRAFT sales_documents row and stops. A person finalises it on
 * the ordinary invoicing screen, through finaliseDocument() — the one posting
 * engine, unchanged and untouched by this module.
 *
 * That is deliverOrder() in salesOrders.ts, whose header states the rule this
 * file obeys: delivering does not get its own posting engine, because a second
 * posting engine is how two code paths start to disagree about what a sale is.
 * Everything a sale must do — move stock, claim a number, hit the debtor ledger,
 * mirror to the GL, check credit, allocate serials — happens there and only
 * there. Nothing in this file imports recordMovement, nextDocumentNumber,
 * postTransaction or mirrorSale, and it must stay that way.
 *
 * ── WHAT MAKES A LINE BILLABLE ─────────────────────────────────────────────
 *
 * BILLABLE_STATES in jobStatusModel.ts, and nothing else. One exported list so
 * the screen offers exactly what the server accepts and the outstanding query
 * filters on the same set — three places asking the same question three
 * different ways is how a pending line ends up billed.
 *
 * ── invoiced_qty IS THE RECORD, NOT A FLAG ─────────────────────────────────
 *
 * A long job is invoiced in stages. A line half billed has half its value still
 * to collect, so what is recorded is a QUANTITY, not a boolean. The refusals
 * below all follow from that: you cannot bill more than is outstanding, and
 * discarding a draft returns the quantity rather than deleting the line.
 */

export type BillableLine = {
  id: number
  lineNumber: number
  lineKind: string
  billingState: BillingState
  productId: number | null
  productCode: string | null
  description: string
  qty: number
  invoicedQty: number
  outstandingQty: number
  unitCostExcl: number
  unitPriceIncl: number
  vatRatePct: number
  discountPct: number
  /** Outstanding quantity at this line's price, VAT inclusive. */
  outstandingValue: number
}

export type InvoiceLineInput = {
  lineId: number
  qty: number
}

export type InvoiceJobResult =
  | { ok: true; invoiceId: number; lineCount: number; totalIncl: number }
  | { ok: false; error: string }

export type ReleaseResult = { ok: true; released: number } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

function todayIso(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * What is still to bill on a job.
 *
 * Only billable states, and only where something is outstanding. This is the
 * invoicing worklist, and it is the predicate the migration's index was built
 * for: ix_jcl_state (job_card_id, billing_state).
 */
export async function billableLines(siteId: number, jobId: number): Promise<BillableLine[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, line_number, line_kind, billing_state, product_id, product_code, description,
            qty, invoiced_qty, unit_cost_excl, unit_price_incl, vat_rate_pct, discount_pct
       FROM job_card_lines
      WHERE job_card_id = ?
        AND billing_state IN (${BILLABLE_STATES.map(() => '?').join(',')})
        AND invoiced_qty < qty
      ORDER BY line_number, id`,
    [jobId, ...BILLABLE_STATES],
  )

  return rows.map((row) => {
    const qty = toNum(row.qty)
    const invoicedQty = toNum(row.invoiced_qty)
    const outstandingQty = round(Math.max(0, qty - invoicedQty), 3)
    const unitPriceIncl = toNum(row.unit_price_incl)
    const discountPct = toNum(row.discount_pct)
    const gross = outstandingQty * unitPriceIncl

    return {
      id: Number(row.id),
      lineNumber: Number(row.line_number),
      lineKind: String(row.line_kind),
      billingState: String(row.billing_state) as BillingState,
      productId: row.product_id === null ? null : Number(row.product_id),
      productCode: row.product_code === null ? null : String(row.product_code),
      description: String(row.description),
      qty,
      invoicedQty,
      outstandingQty,
      unitCostExcl: toNum(row.unit_cost_excl),
      unitPriceIncl,
      vatRatePct: toNum(row.vat_rate_pct),
      discountPct,
      outstandingValue: round(gross - gross * (discountPct / 100), 2),
    }
  })
}

/**
 * Raise a draft invoice for the chosen lines.
 *
 * Everything is validated before anything is written, so a bad request cannot
 * leave a job half invoiced — the same discipline deliverOrder() applies, and for
 * the same reason.
 */
export async function invoiceJob(
  siteId: number,
  actor: Actor,
  jobId: number,
  selections: readonly InvoiceLineInput[],
  options: { documentDate?: string; notes?: string | null } = {},
): Promise<InvoiceJobResult> {
  const cdb = await customerDbPrefix(siteId)
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT j.id, j.document_number, j.status, j.customer_id, j.customer_name,
            j.customer_phone, j.reference,
            c.vat_number AS customer_vat_no,
            c.address_line1, c.address_line2, c.city, c.postal_code
       FROM job_cards j
       LEFT JOIN ${cdb}customers c ON c.id = j.customer_id
      WHERE j.id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }

  if (String(job.status) === 'cancelled') {
    return { ok: false, error: 'A cancelled job cannot be invoiced.' }
  }

  /*
   * A walk-in job has no account, and that is allowed — but an invoice needs
   * somebody to send it to. This is where the nullable customer_id is paid for,
   * and it is a sentence rather than a schema constraint precisely so the job
   * could be captured in the first place.
   */
  if (job.customer_id === null) {
    return {
      ok: false,
      error: 'This job has no customer account. Attach one before invoicing it.',
    }
  }

  const wanted = selections.filter((s) => round(s.qty, 3) > 0)
  if (wanted.length === 0) return { ok: false, error: 'Choose at least one line to invoice.' }

  const available = await billableLines(siteId, jobId)
  const byId = new Map(available.map((line) => [line.id, line]))

  const planned: { line: BillableLine; qty: number }[] = []
  for (const selection of wanted) {
    const line = byId.get(selection.lineId)
    if (!line) {
      return {
        ok: false,
        error: 'One of those lines is no longer billable — it may have been invoiced already.',
      }
    }
    if (!isBillable(line.billingState)) {
      return { ok: false, error: `${line.description} is not marked as billable.` }
    }
    const qty = round(selection.qty, 3)
    if (qty > line.outstandingQty) {
      return {
        ok: false,
        error: `Only ${line.outstandingQty} of ${line.description} is still to invoice.`,
      }
    }
    planned.push({ line, qty })
  }

  const documentDate = options.documentDate ?? todayIso()
  const jobLabel = job.document_number ? String(job.document_number) : `#${jobId}`
  const address = [job.address_line1, job.address_line2, job.city, job.postal_code]
    .map((part) => (part === null || part === undefined ? '' : String(part).trim()))
    .filter(Boolean)
    .join(', ')

  const result = await siteTransaction(siteId, async (tx) => {
    /*
     * A draft, deliberately. No document_number: sequences.ts issues one at
     * finalise, and a draft that is abandoned must not burn an invoice number.
     * job_card_id is the link the whole module hangs on — one column on
     * sales_documents, added by 104.
     */
    const [res] = await tx.execute(
      `INSERT INTO sales_documents
         (doc_type, status, document_date, customer_id, customer_name, customer_vat_no,
          customer_phone, customer_address, user_id, user_name, reference, notes,
          job_card_id, origin, subtotal_excl, vat_total, discount_total, total_incl)
       VALUES ('invoice','draft',?,?,?,?,?,?,?,?,?,?,?,'back_office',0,0,0,0)`,
      [
        documentDate,
        job.customer_id,
        job.customer_name,
        job.customer_vat_no ?? null,
        job.customer_phone ?? null,
        address || null,
        actor.userId,
        actor.userName.slice(0, 120),
        job.reference ?? null,
        options.notes ?? `Job ${jobLabel}`,
        jobId,
      ] as never,
    )
    const invoiceId = Number((res as { insertId: number }).insertId)

    let lineNumber = 0
    let totalIncl = 0

    for (const { line, qty } of planned) {
      lineNumber += 1

      /*
       * documentMath owns the arithmetic; this only chooses the quantity it works
       * on. The discount is a PERCENTAGE of the line, so it scales with a part
       * invoice — an absolute amount would give the customer the whole job's
       * discount on the first instalment.
       */
      const totals = lineTotals({
        qty,
        unitPriceIncl: line.unitPriceIncl,
        discountPct: line.discountPct,
        vatRatePct: line.vatRatePct,
      })

      await tx.execute(
        `INSERT INTO sales_document_lines
           (document_id, line_number, product_id, job_card_line_id, product_code, description,
            product_type, qty, unit_price_incl, discount_pct, discount_incl, vat_rate_pct,
            line_total_incl, line_total_excl, line_vat, unit_cost_excl)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          invoiceId,
          lineNumber,
          line.productId,
          // The link back, so discarding this draft returns the quantity to the
          // right line even when two lines read the same.
          line.id,
          line.productCode,
          line.description,
          // A job line with no product is a charge: a callout fee, a
          // subcontractor invoice. 'service' is the existing non-stocked type,
          // so it reaches the invoice through the ordinary path and moves no
          // stock, with no special case in documentMath or the posting engine.
          line.productId === null ? 'service' : 'normal',
          qty.toFixed(3),
          line.unitPriceIncl.toFixed(4),
          line.discountPct.toFixed(3),
          totals.discountIncl.toFixed(4),
          line.vatRatePct.toFixed(3),
          totals.lineTotalIncl.toFixed(4),
          totals.lineTotalExcl.toFixed(4),
          totals.lineVat.toFixed(4),
          line.unitCostExcl.toFixed(4),
        ] as never,
      )

      /*
       * The job line records what has been billed. invoiced_doc_id names the
       * LATEST invoice a line appeared on; invoiced_qty is the cumulative total
       * and is what the outstanding predicate reads. For a line billed in one go
       * the two agree, and for a staged line the quantity is the truth.
       */
      await tx.execute(
        `UPDATE job_card_lines
            SET invoiced_qty = invoiced_qty + ?, invoiced_doc_id = ?
          WHERE id = ?`,
        [qty.toFixed(3), invoiceId, line.id] as never,
      )

      /*
       * Whatever is being billed stops being merely claimed (220).
       *
       * A part on a draft invoice is on its way out of the building, and holding
       * a reservation for it as well would deduct it twice from what the till
       * may sell. Released by the exact quantity, so a line billed three of ten
       * keeps its claim on the other seven.
       *
       * In THIS transaction, so the claim and the billing commit together.
       */
      await releaseLine(tx, line.id, qty)

      totalIncl += totals.lineTotalIncl
    }

    // Header totals from the lines just written, so the draft is balanced before
    // anything reads it. Same statement as deliverOrder.
    await tx.execute(
      `UPDATE sales_documents d
          SET subtotal_excl  = (SELECT COALESCE(SUM(line_total_excl),0) FROM sales_document_lines WHERE document_id = d.id),
              vat_total      = (SELECT COALESCE(SUM(line_vat),0)        FROM sales_document_lines WHERE document_id = d.id),
              discount_total = (SELECT COALESCE(SUM(discount_incl),0)   FROM sales_document_lines WHERE document_id = d.id),
              total_incl     = (SELECT COALESCE(SUM(line_total_incl),0) FROM sales_document_lines WHERE document_id = d.id)
        WHERE d.id = ?`,
      [invoiceId] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'invoiced',
      detail: `Draft invoice raised for ${lineNumber} ${lineNumber === 1 ? 'line' : 'lines'}`,
    })

    return { invoiceId, lineCount: lineNumber, totalIncl: round(totalIncl, 2) }
  })

  return { ok: true, ...result }
}

/**
 * Give the quantities back when a draft raised from a job is discarded.
 *
 * fk_jcl_invoice is SET NULL, so deleting the draft would clear invoiced_doc_id
 * and leave invoiced_qty behind — the line would claim to have been billed with
 * nothing to show for it, and would never appear on the worklist again. That is
 * the drift reconcileJobCards() reports as overInvoiced, and this is what stops
 * it happening in the first place.
 *
 * Only a DRAFT may be released. A finalised invoice is a tax document, and the
 * remedy for one of those is a credit note.
 */
export async function releaseJobLines(
  siteId: number,
  actor: Actor,
  invoiceId: number,
): Promise<ReleaseResult> {
  return siteTransaction(siteId, async (tx) => {
    const [docRows] = await tx.query<Row[]>(
      `SELECT id, status, job_card_id, document_number FROM sales_documents WHERE id = ?`,
      [invoiceId],
    )
    const doc = docRows[0]
    if (!doc) return { ok: false as const, error: 'That invoice no longer exists.' }
    if (doc.job_card_id === null) return { ok: true as const, released: 0 }

    if (String(doc.status) !== 'draft') {
      return {
        ok: false as const,
        error: `${doc.document_number ? String(doc.document_number) : 'That invoice'} has been issued. Credit it rather than discarding it.`,
      }
    }

    /*
     * Subtract exactly what this invoice took, matched by job_card_line_id and
     * not by description: two lines reading "Replace capacitor" are two
     * different lines, and matching on the text would reset the wrong one.
     *
     * Subtracted rather than zeroed, because a line billed across two invoices
     * must only give back the half this document carried.
     */
    const [lineRows] = await tx.query<Row[]>(
      `SELECT job_card_line_id, qty
         FROM sales_document_lines
        WHERE document_id = ? AND job_card_line_id IS NOT NULL`,
      [invoiceId],
    )

    for (const row of lineRows) {
      /*
       * invoiced_doc_id is cleared only if it still points at THIS invoice. A
       * line billed again on a later draft has moved on, and blanking it would
       * strand that newer link.
       */
      await tx.execute(
        `UPDATE job_card_lines
            SET invoiced_qty = GREATEST(0, invoiced_qty - ?),
                invoiced_doc_id = CASE WHEN invoiced_doc_id = ? THEN NULL ELSE invoiced_doc_id END
          WHERE id = ?`,
        [toNum(row.qty).toFixed(3), invoiceId, Number(row.job_card_line_id)] as never,
      )
    }

    /*
     * The claim comes back with the quantity (220).
     *
     * Discarding a draft returns these lines to the worklist, so the parts are
     * promised to this customer again and must stop being sellable to somebody
     * else. Re-derived from the job's ACCEPTED QUOTE rather than by adding back
     * what was released: if the quote was superseded while the draft sat there,
     * the old claim is no longer what the customer agreed to, and reinstating it
     * would hold stock against a version nobody accepted.
     *
     * A job with no accepted quote reserves nothing, which is the honest answer
     * — an invoice raised without one was never backed by a promise.
     */
    const acceptedQuoteId = doc.job_card_id === null ? null : await acceptedQuoteFor(tx, Number(doc.job_card_id))
    if (acceptedQuoteId !== null) {
      await reserveForQuote(tx, Number(doc.job_card_id), acceptedQuoteId)
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: Number(doc.job_card_id),
      action: 'invoice_discarded',
      detail: `${lineRows.length} ${lineRows.length === 1 ? 'line' : 'lines'} returned to the worklist`,
    })

    return { ok: true as const, released: lineRows.length }
  })
}

/**
 * Every document a job has produced, newest first.
 *
 * Quotes and invoices in one list, because from the job's point of view they are
 * the same thing: paper it generated. Which is which is doc_type, and the screen
 * groups on it.
 */
export async function jobDocuments(
  siteId: number,
  jobId: number,
): Promise<
  { id: number; docType: string; documentNumber: string | null; status: string; date: string; totalIncl: number }[]
> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, doc_type, document_number, status, document_date, total_incl
       FROM sales_documents
      WHERE job_card_id = ?
      ORDER BY document_date DESC, id DESC`,
    [jobId],
  )
  return rows.map((row) => ({
    id: Number(row.id),
    docType: String(row.doc_type),
    documentNumber: row.document_number === null ? null : String(row.document_number),
    status: String(row.status),
    date: String(row.document_date),
    totalIncl: toNum(row.total_incl),
  }))
}
