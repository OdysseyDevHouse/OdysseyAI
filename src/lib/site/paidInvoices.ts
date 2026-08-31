import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { customerQuery, customerQueryOne } from './customerDb'
import { postTransaction } from './customerLedger'
import { getDocument } from './salesDocuments'
import type { Actor } from './activityLog'

/**
 * Settling an invoice that was paid through its emailed pay-link.
 *
 * The debtor-side counterpart to paidOrders.ts. Called ONLY from the PayFast ITN
 * handler, and only after that handler has verified the payload — signature,
 * source IP, post-back, merchant and amount — and successfully claimed the
 * intent. This function trusts what it is told, exactly as invoicePaidOrder
 * does, because the checking has already happened upstream.
 *
 * ── WHY THIS IS A RECEIPT AND NOT A NEW SALE ─────────────────────────────
 *
 * The invoice already exists. It was posted to the customer's account when the
 * contract billed it, it already moved stock and already declared its VAT. What
 * arrives now is MONEY against that debt — a `payment` on the sub-ledger, which
 * auto-allocates against the oldest open items.
 *
 * Raising anything else here would double-count: a second invoice would bill
 * the customer twice for one month, and a journal would leave the original
 * invoice looking unpaid for ever.
 *
 * ── VAT IS NOT DECLARED AGAIN ────────────────────────────────────────────
 *
 * A receipt carries no VAT. The tax point was the invoice, and declaring output
 * VAT on the payment as well would overstate the VAT return by the full amount
 * of every online payment — the kind of error that surfaces as an assessment.
 */

type Row = RowDataPacket & Record<string, unknown>

export type SettleInvoiceResult =
  | { ok: true; transactionId: number; customerId: number }
  | { ok: false; error: string }

/**
 * Records a confirmed online payment against an invoice.
 *
 * Idempotent through `source_doc_id` plus the reference: the ITN handler's own
 * status guard already makes a replay a no-op, and this second check covers the
 * case where the same invoice is somehow paid through two separate intents —
 * where the money really did arrive twice and a person must decide what to do.
 */
export async function settlePaidInvoice(
  siteId: number,
  actor: Actor,
  documentId: number,
  amountPaid: number,
  providerRef: string,
): Promise<SettleInvoiceResult> {
  const document = await getDocument(siteId, documentId)
  if (!document) return { ok: false, error: 'That invoice no longer exists.' }
  if (!document.customerId) {
    return { ok: false, error: 'That invoice is not on a customer account.' }
  }
  // A draft was never owed, so a payment against it has nothing to settle.
  if (document.status !== 'finalised') {
    return { ok: false, error: 'That invoice has not been posted.' }
  }

  // Already receipted through this same provider reference — a duplicate
  // callback that slipped past the intent guard. Reported as success because
  // the desired state already holds.
  const existing = await customerQueryOne<Row>(
    siteId,
    `SELECT id FROM customer_transactions
      WHERE doc_type = 'payment' AND source = 'payfast' AND reference = ?
      LIMIT 1`,
    [providerRef],
  )
  if (existing) {
    return {
      ok: true,
      transactionId: Number(existing.id),
      customerId: document.customerId,
    }
  }

  const posted = await postTransaction(siteId, actor, {
    customerId: document.customerId,
    docType: 'payment',
    // NOT the invoice's own number: a payment sharing an invoice's number would
    // trip the ledger's duplicate-number guard and read as a second copy of the
    // invoice on the statement.
    docNumber: null,
    docDate: undefined,
    reference: providerRef,
    description: `Online payment — ${document.documentNumber ?? `invoice #${documentId}`}`,
    amount: Math.abs(amountPaid),
    // No VAT on a receipt. See the header.
    vatRatePct: 0,
    source: 'payfast',
    sourceDocId: documentId,
    // Settles the invoice it was raised against, oldest-first. Without this the
    // customer's balance is right but every document still shows as open, and
    // the age analysis keeps chasing an invoice that has been paid.
    autoAllocate: true,
  })

  if (!posted.ok) return { ok: false, error: posted.error }

  return { ok: true, transactionId: posted.id, customerId: document.customerId }
}

/**
 * The invoice behind a pay-link, for the landing page.
 *
 * Deliberately returns only what a payer needs to see before paying — who it is
 * for, what it is for and how much. No line detail, no account balance, no
 * customer record: the page is reachable by anyone holding the link, and the
 * link is emailed, forwarded and left in inboxes.
 */
export async function payableInvoice(
  siteId: number,
  documentId: number,
): Promise<{
  documentNumber: string | null
  documentDate: string
  dueDate: string | null
  customerName: string | null
  totalIncl: number
  outstanding: number
} | null> {
  const document = await getDocument(siteId, documentId)
  if (!document || document.status !== 'finalised') return null

  const outstanding = await outstandingForDocument(siteId, document)

  return {
    documentNumber: document.documentNumber,
    documentDate: document.documentDate,
    dueDate: document.dueDate,
    customerName: document.customerName,
    totalIncl: document.totalIncl,
    outstanding,
  }
}

/**
 * What has been paid against one invoice, and what is left.
 *
 * ── WHY THE INVOICE SCREEN COULD NOT ANSWER THIS ──────────────────────────
 *
 * It showed deposits and nothing else. A receipt lands on the CUSTOMER's
 * account, so the only way to learn whether an invoice had been paid was to
 * leave the invoice, open the account, and read the ledger — which meant an
 * online payment could arrive and the invoice screen would look exactly as it
 * did before.
 *
 * ── ALLOCATIONS, NOT PAYMENTS ─────────────────────────────────────────────
 *
 * Read through customer_allocations rather than by looking for payments whose
 * source_doc_id is this invoice. The two are different questions and only one
 * of them is the right one:
 *
 *   a payment made against the ACCOUNT (a statement payment, an EFT keyed by
 *   hand) has no source_doc_id at all, and yet auto-allocation may have used it
 *   to settle this very invoice;
 *
 *   a credit note or a journal can settle an invoice too, and neither is a
 *   payment.
 *
 * The allocation row is the record of what actually settled what, which is the
 * question somebody looking at an invoice is asking.
 *
 * A cash sale has no ledger entry at all, so this returns nothing for one — and
 * `outstandingForDocument` below already answers that case from the tenders.
 */
export type InvoicePayment = {
  id: number
  docType: string
  docNumber: string | null
  docDate: string
  reference: string | null
  description: string | null
  /** How much of THIS credit went to THIS invoice — not the credit's total. */
  applied: number
  source: string
  allocatedAt: Date | null
}

export async function paymentsForDocument(
  siteId: number,
  documentId: number,
): Promise<InvoicePayment[]> {
  const rows = await customerQuery<Row>(
    siteId,
    `SELECT c.id, c.doc_type, c.doc_number, c.doc_date, c.reference, c.description,
            c.source, a.amount AS applied, a.allocated_at
       FROM customer_transactions d
       JOIN customer_allocations a ON a.debit_txn_id = d.id
       JOIN customer_transactions c ON c.id = a.credit_txn_id
      WHERE d.source_doc_id = ?
        -- Scoped to THIS store: document ids are per-database, so in a shared
        -- ledger the id alone would match another branch's invoice.
        AND (d.origin_site_id IS NULL OR d.origin_site_id = ?)
        AND d.doc_type = 'invoice'
      ORDER BY a.allocated_at DESC, a.id DESC`,
    [documentId, siteId],
  )

  return rows.map((r) => ({
    id: Number(r.id),
    docType: String(r.doc_type),
    docNumber: (r.doc_number as string | null) ?? null,
    docDate: String(r.doc_date),
    reference: (r.reference as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    applied: Number(r.applied),
    source: String(r.source ?? ''),
    allocatedAt: (r.allocated_at as Date | null) ?? null,
  }))
}

/**
 * What is STILL owed on one finalised invoice.
 *
 * An ACCOUNT sale has a debtor entry, and its amount_outstanding is the
 * answer. A cash/till sale has NO ledger row — the old fallback here treated
 * that as "the whole total is owed", which asked a customer who paid cash at
 * the counter to pay again through the pay link. The tenders on the document
 * are the truth for that case: total less what was actually taken.
 */
export async function outstandingForDocument(
  siteId: number,
  document: {
    id: number
    totalIncl: number
    tenderedTotal: number
    changeGiven: number
  },
): Promise<number> {
  const row = await customerQueryOne<Row>(
    siteId,
    `SELECT amount_outstanding FROM customer_transactions
      WHERE source_doc_id = ?
        -- Scoped to THIS store. Document ids are per-database, so in a shared
        -- ledger the id alone would match another branch's invoice and report
        -- the wrong amount still owing.
        AND (origin_site_id IS NULL OR origin_site_id = ?)
        AND doc_type = 'invoice' LIMIT 1`,
    [document.id, siteId],
  )
  if (row) return Math.max(Number(row.amount_outstanding), 0)

  const paid = Math.max(0, document.tenderedTotal - document.changeGiven)
  return Math.max(0, Math.round((document.totalIncl - paid) * 100) / 100)
}
