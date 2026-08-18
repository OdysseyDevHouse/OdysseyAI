import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne, siteTransaction } from '../siteDb'
import { formatMoney, round, toNum } from '../decimals'
import { dueDateFor } from './ledger'
import { guardPosting } from './periodLocks'
import { getPurchaseDocument } from './purchaseDocuments'
import type { Actor } from './activityLog'

/**
 * Recording the supplier's invoice against goods already received.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A GRNI ACCRUAL ────────────────────
 *
 * Receiving already raises the liability. receiveGoods() posts a real invoice
 * to the creditor ledger and mirrorGrv() credits creditors control — whether or
 * not anybody typed an invoice number. So there is no unrecorded liability
 * here, and a goods-received-not-invoiced accrual account would create a SECOND
 * liability for goods that already have one.
 *
 * What is genuinely missing is smaller and entirely practical. When a delivery
 * is received on a delivery note, the creditor row falls back to OUR GRV number
 * (see receiveGoods). The supplier's statement then quotes their number, the
 * payment run matches on ours, and the two do not reconcile — every month, by
 * hand. This closes that: when their invoice turns up, it is written onto the
 * row that is already there.
 *
 * ── IT UPDATES, IT NEVER POSTS ───────────────────────────────────────────
 *
 * The single most important property. Posting a second invoice would double the
 * liability and, worse, would be PAID twice — which is exactly what the
 * duplicate-number guard in postSupplierTransaction exists to prevent. So this
 * writes doc_number, doc_date and due_date on the existing row and touches no
 * amount at all.
 *
 * Because no amount moves, no GL journal is needed: the creditor balance, the
 * stock value and the control account are all already correct and stay that
 * way. The only thing changing is what the invoice is CALLED and when it is
 * due — which is a fact about the paperwork, not about the money.
 *
 * ── WHAT IT WILL NOT TOUCH ───────────────────────────────────────────────
 *
 * A row that has been paid or part-paid. Moving a due date under an allocation
 * would restate an age analysis that somebody has already acted on, and moving
 * the number would orphan the remittance that quoted the old one. By then the
 * instrument is a credit note and a re-invoice, not a rename.
 *
 * A closed period, when the date moves. Re-dating an invoice into or out of a
 * locked VAT period is exactly the move period locks exist to refuse.
 */

type Row = RowDataPacket & Record<string, unknown>

export type MatchResult = { ok: true; changed: string[] } | { ok: false; error: string }

/** What is on file for a receipt, so a screen can show it before changing it. */
export type InvoiceMatchState = {
  /** The creditor row raised by this receipt, if it is still there. */
  transactionId: number | null
  /** What the creditor ledger currently calls it. */
  docNumber: string | null
  docDate: string | null
  dueDate: string | null
  amountGross: number
  /** How much is still owed. Anything less than gross means it has been paid against. */
  outstanding: number
  /**
   * True when doc_number is still OUR GRV number rather than theirs — the
   * state this whole module exists to get out of.
   */
  awaitingInvoice: boolean
}

/**
 * The creditor row behind a GRV.
 *
 * Found on (source, source_doc_id) rather than by number, because the number is
 * the very thing that may be wrong. Freight rows are excluded by matching the
 * goods supplier — a third-party carrier's invoice on the same receipt is its
 * own document with its own number and is not renamed by this.
 */
export async function invoiceMatchState(
  siteId: number,
  documentId: number,
): Promise<InvoiceMatchState | null> {
  const doc = await getPurchaseDocument(siteId, documentId)
  if (!doc || doc.docType !== 'grv' || doc.status !== 'finalised') return null

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id, doc_number, doc_date, due_date, amount_gross, amount_outstanding
       FROM supplier_transactions
      WHERE source = 'purchase' AND source_doc_id = ?
        AND supplier_id = ? AND doc_type = 'invoice'
      ORDER BY id LIMIT 1`,
    [documentId, doc.supplierId],
  )
  if (!row) {
    return {
      transactionId: null,
      docNumber: null,
      docDate: null,
      dueDate: null,
      amountGross: 0,
      outstanding: 0,
      awaitingInvoice: false,
    }
  }

  const docNumber = (row.doc_number as string | null) ?? null
  return {
    transactionId: Number(row.id),
    docNumber,
    docDate: isoOf(row.doc_date),
    dueDate: isoOf(row.due_date),
    amountGross: toNum(row.amount_gross),
    outstanding: toNum(row.amount_outstanding),
    // Our own GRV number standing in for theirs. Compared against the
    // document's own number rather than a prefix, because a site can rename
    // its sequences and "starts with GRV" would then be wrong.
    awaitingInvoice: !!docNumber && docNumber === doc.documentNumber,
  }
}

export type MatchInput = {
  /** Their invoice number. Required — this is the whole point. */
  invoiceNo: string
  /**
   * Their invoice date. Optional: when given it re-dates the creditor row and
   * recomputes the due date off the supplier's terms, because a delivery note
   * dated the 28th and an invoice dated the 2nd are different months to pay.
   */
  invoiceDate?: string | null
}

export async function matchSupplierInvoice(
  siteId: number,
  actor: Actor,
  documentId: number,
  input: MatchInput,
): Promise<MatchResult> {
  const invoiceNo = input.invoiceNo.trim().slice(0, 32)
  if (!invoiceNo) return { ok: false, error: 'Enter their invoice number.' }
  if (input.invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate)) {
    return { ok: false, error: 'That date is not valid.' }
  }

  const doc = await getPurchaseDocument(siteId, documentId)
  if (!doc) return { ok: false, error: 'That receipt no longer exists.' }
  if (doc.docType !== 'grv') {
    return { ok: false, error: `A ${doc.docLabel.toLowerCase()} has no supplier invoice to match.` }
  }
  if (doc.status !== 'finalised') {
    return { ok: false, error: 'Only a posted receipt can have its invoice recorded.' }
  }

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id, doc_number, doc_date, amount_gross, amount_outstanding
       FROM supplier_transactions
      WHERE source = 'purchase' AND source_doc_id = ?
        AND supplier_id = ? AND doc_type = 'invoice'
      ORDER BY id LIMIT 1`,
    [documentId, doc.supplierId],
  )
  if (!row) {
    return {
      ok: false,
      error: 'This receipt has no creditor entry to attach an invoice to.',
    }
  }

  const transactionId = Number(row.id)
  const gross = toNum(row.amount_gross)
  const outstanding = toNum(row.amount_outstanding)

  // Paid or part-paid: by now the number is on a remittance and the due date
  // has been acted on. See the header — this is a rename, not a restatement.
  if (round(outstanding, 2) !== round(gross, 2)) {
    return {
      ok: false,
      error: `${formatMoney(round(gross - outstanding, 2))} has already been paid against this invoice. Raise a credit note and re-invoice instead.`,
    }
  }

  // Somebody else's document already answers to this number on this account.
  // The same guard postSupplierTransaction applies at posting time, for the
  // same reason: a supplier invoice on file twice gets paid twice.
  const clash = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM supplier_transactions
      WHERE supplier_id = ? AND doc_number = ? AND doc_type = 'invoice' AND id <> ?
      LIMIT 1`,
    [doc.supplierId, invoiceNo, transactionId],
  )
  if (clash) {
    return {
      ok: false,
      error: `${invoiceNo} is already on this supplier's account as invoice #${clash.id}.`,
    }
  }

  const currentDate = isoOf(row.doc_date)
  const newDate = input.invoiceDate?.trim() || null
  const dateMoves = !!newDate && newDate !== currentDate

  // Both ends when the date moves: out of the period it sits in now, and into
  // the one it is going to. Locking only the destination would let an invoice
  // be walked out of a closed period one day at a time.
  if (dateMoves) {
    for (const when of [currentDate, newDate]) {
      if (!when) continue
      const locked = await guardPosting(siteId, when, 'ledger')
      if (locked) return { ok: false, error: locked }
    }
  }

  const supplier = await siteQueryOne<Row>(
    siteId,
    'SELECT payment_terms_days FROM suppliers WHERE id = ? LIMIT 1',
    [doc.supplierId],
  )
  const terms = Number(supplier?.payment_terms_days ?? 30)

  const changed: string[] = []
  const previousNumber = (row.doc_number as string | null) ?? ''
  if (previousNumber !== invoiceNo) changed.push('number')
  if (dateMoves) changed.push('date')
  if (changed.length === 0) return { ok: true, changed: [] }

  await siteTransaction(siteId, async (tx) => {
    if (dateMoves && newDate) {
      // The due date follows the invoice date off the supplier's terms, the
      // same way postSupplierTransaction computed it in the first place.
      // Leaving it behind would age the invoice from a delivery note date the
      // supplier never agreed to.
      const due = dueDateFor('invoice', newDate, terms)
      await tx.execute(
        'UPDATE supplier_transactions SET doc_number = ?, doc_date = ?, due_date = ? WHERE id = ?',
        [invoiceNo, newDate, due, transactionId] as never,
      )
    } else {
      await tx.execute('UPDATE supplier_transactions SET doc_number = ? WHERE id = ?', [
        invoiceNo,
        transactionId,
      ] as never)
    }

    // The GRV's own record of their invoice, so the document screen and the
    // purchasing list agree with the creditor ledger.
    await tx.execute('UPDATE purchase_documents SET supplier_invoice_no = ? WHERE id = ?', [
      invoiceNo,
      documentId,
    ] as never)
  })

  await recordMatch(siteId, actor, documentId, doc.documentNumber, previousNumber, invoiceNo, newDate)
  return { ok: true, changed }
}

/**
 * The trail.
 *
 * Records what the row was called BEFORE, which is the question asked when a
 * supplier queries a payment: their statement quotes one number, our remittance
 * quoted another, and this line is what joins them.
 *
 * Silent where 139 has not reached this site — and by here the update has
 * already committed, so throwing would report a failure that did not happen.
 */
async function recordMatch(
  siteId: number,
  actor: Actor,
  documentId: number,
  grvNumber: string | null,
  from: string,
  to: string,
  newDate: string | null,
): Promise<void> {
  const exists = await siteQueryOne<RowDataPacket>(
    siteId,
    `SELECT 1 AS ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_document_audit' LIMIT 1`,
  ).catch(() => null)
  if (!exists) return

  const detail = [
    `${grvNumber ?? `#${documentId}`} · invoice ${to}`,
    from && from !== to ? `was ${from}` : '',
    newDate ? `dated ${newDate}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  await siteExecute(
    siteId,
    `INSERT INTO purchase_document_audit (document_id, action, detail, user_id, user_name)
     VALUES (?, 'invoice_matched', ?, ?, ?)`,
    [documentId, detail.slice(0, 300), actor.userId, actor.userName.slice(0, 120)],
  ).catch(() => undefined)
}

/** The pool parses DATETIME as UTC, so a wall-clock date reads back with getUTC*. */
function isoOf(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}`
  }
  const text = String(value)
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null
}
