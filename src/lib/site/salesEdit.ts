import 'server-only'
import { siteQuery, siteQueryOne } from '@/lib/siteDb'
import { round, toNum } from '@/lib/decimals'
import { isPeriodLocked } from './settings'
import { can, type CapabilitySet } from './permissions'
import { getDocument, saveDraft, type SalesDocument, type LineInput } from './salesDocuments'
import { createCreditNote } from './salesReversal'
import { CORRECTION_REASON_CODE, findSalesReasonByCode } from './salesReasons'
import { finaliseDocument } from './salesPosting'
import type { Actor } from './activityLog'

/**
 * Correcting a finalised invoice.
 *
 * ── WHY THIS CANNOT BE AN UPDATE ─────────────────────────────────────────
 *
 * By the time an invoice is finalised: stock has moved and the goods have
 * left the shop; a ledger entry exists whose amount_outstanding may be partly
 * allocated against a payment; a VAT figure sits in a period that may already
 * have been reported; and the customer is holding a printed document bearing
 * that number.
 *
 * Mutating the row makes every one of those quietly wrong. Worse, an audit
 * log saying "total changed R500 → R450" next to a ledger entry still saying
 * R500 is WORSE than no log at all, because it looks trustworthy.
 *
 * So this is reverse-and-repost, atomically:
 *
 *   1. refuse outright if any of the five guards below fails
 *   2. credit the original in full, through the ordinary credit-note path
 *   3. raise a new invoice with the corrected lines, through the ordinary
 *      finalise path so every guard runs again
 *
 * The user is shown "corrected", because that is their mental model. The
 * ledger's model is three sound documents, and both are true.
 *
 * ── THE FIVE GUARDS ──────────────────────────────────────────────────────
 *
 * Refused if: a payment is allocated against it; the VAT period is locked; a
 * credit note already exists against it; the role lacks sales.edit_finalised;
 * or the document is not a finalised invoice. Each is checked before anything
 * is written, and each names what to do instead.
 *
 * Never changes the document number or the document date. The new invoice
 * gets its own number from the ordinary sequence, so the numbering stays
 * gap-free and every number remains explainable.
 */

type Row = Record<string, unknown>

export type EditRefusal = {
  reason: string
  /** What to do instead. A refusal without an alternative is just a wall. */
  suggestion: string
}

export type EditableCheck =
  | { ok: true; document: SalesDocument }
  | { ok: false; refusal: EditRefusal }

/**
 * Everything that stops an invoice being corrected. Read-only.
 *
 * Exported so the UI can grey the button and explain WHY before the user
 * commits to a flow that will refuse them.
 */
export async function canEditFinalised(
  siteId: number,
  capabilities: CapabilitySet,
  documentId: number,
): Promise<EditableCheck> {
  if (!can(capabilities, 'sales.edit_finalised')) {
    return {
      ok: false,
      refusal: {
        reason: 'Your role cannot correct a finalised invoice.',
        suggestion: 'Ask an owner, or raise a credit note instead.',
      },
    }
  }

  const document = await getDocument(siteId, documentId)
  if (!document) {
    return { ok: false, refusal: { reason: 'That document no longer exists.', suggestion: '' } }
  }
  if (document.docType !== 'invoice') {
    return {
      ok: false,
      refusal: {
        reason: `A ${document.docLabel.toLowerCase()} cannot be corrected this way.`,
        suggestion: 'Only a finalised invoice can be corrected.',
      },
    }
  }
  if (document.status !== 'finalised') {
    return {
      ok: false,
      refusal: {
        reason: `This invoice is ${document.status}.`,
        suggestion: document.status === 'cancelled'
          ? 'A voided invoice is already undone — ring the sale up again.'
          : 'Only a finalised invoice can be corrected.',
      },
    }
  }

  // A credit note already exists: correcting on top of one would produce two
  // reversals of the same invoice and a customer statement nobody can read.
  const credited = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS count FROM sales_documents
      WHERE reverses_id = ? AND doc_type = 'credit_sale' AND status = 'finalised'`,
    [documentId],
  )
  if (Number(credited?.count ?? 0) > 0) {
    return {
      ok: false,
      refusal: {
        reason: 'This invoice has already been credited.',
        suggestion: 'Raise a further credit note, or a new invoice for the difference.',
      },
    }
  }

  // A payment allocated against it: reversing would strand the allocation, and
  // un-allocating someone's payment silently is not something a correction
  // should do behind their back.
  if (document.customerId) {
    const allocated = await siteQueryOne<Row>(
      siteId,
      `SELECT COALESCE(SUM(a.amount), 0) AS allocated
         FROM customer_allocations a
         JOIN customer_transactions t ON t.id = a.debit_txn_id
        WHERE t.source_doc_id = ? AND t.doc_type = 'invoice'`,
      [documentId],
    )
    if (toNum(allocated?.allocated) > 0) {
      return {
        ok: false,
        refusal: {
          reason: `A payment of ${toNum(allocated?.allocated).toFixed(2)} has been allocated against this invoice.`,
          suggestion: 'Un-allocate the payment first, or raise a credit note and re-invoice.',
        },
      }
    }
  }

  // The period lock is the only thing standing between a correction and a
  // restated VAT return.
  if (await isPeriodLocked(siteId, document.documentDate)) {
    return {
      ok: false,
      refusal: {
        reason: `The VAT period covering ${document.documentDate} is locked.`,
        suggestion: 'Raise a credit note dated today instead.',
      },
    }
  }

  return { ok: true, document }
}

export type EditLineInput = LineInput

export type EditResult =
  | {
      ok: true
      /** The corrected invoice — the one the user now sees. */
      documentId: number
      documentNumber: string
      /** The credit note that reversed the original. */
      creditNoteId: number
      creditNoteNumber: string
      /** What the original was, for the banner on the new one. */
      replacedNumber: string
    }
  | { ok: false; error: string; suggestion?: string }

/**
 * Corrects a finalised invoice by reversing it and reposting.
 *
 * The three documents are written in an order that is safe to interrupt:
 * credit first, then the replacement. If the replacement fails, the customer
 * is left with an invoice and a matching credit note — a net zero that is
 * correct, explainable, and fixable by ringing the sale up again. The reverse
 * order would leave two live invoices, which is not.
 *
 * `tenders` are re-taken because the corrected total may differ; the caller
 * supplies them exactly as it would for a fresh sale.
 */
export async function editFinalisedDocument(
  siteId: number,
  actor: Actor,
  capabilities: CapabilitySet,
  input: {
    documentId: number
    reason: string
    lines: EditLineInput[]
    tenders: { tenderTypeId: number; amount: number; reference?: string | null }[]
    /** Refund tenders for the reversing credit note. */
    refunds?: { tenderTypeId: number; amount: number; reference?: string | null }[]
    customerId?: number | null
  },
): Promise<EditResult> {
  if (!input.reason?.trim()) {
    return { ok: false, error: 'Give a reason for the correction — it goes on the audit trail.' }
  }
  if (input.lines.length === 0) {
    return { ok: false, error: 'A corrected invoice needs at least one line.' }
  }

  const check = await canEditFinalised(siteId, capabilities, input.documentId)
  if (!check.ok) {
    return { ok: false, error: check.refusal.reason, suggestion: check.refusal.suggestion }
  }
  const original = check.document

  // ── 1. Reverse the original in full, through the ordinary credit path so
  //       every rule it enforces — cost from the original line, stock back,
  //       ledger reversed — applies unchanged.
  // Nothing came back and nobody chose a return reason: this is a correction,
  // and the dedicated code keeps it out of the returns report rather than
  // letting it borrow OTHER. Missing only if a site deleted a seeded row.
  const correctionReason = await findSalesReasonByCode(
    siteId,
    'return',
    CORRECTION_REASON_CODE,
  )
  if (!correctionReason) {
    return {
      ok: false,
      error:
        'The Invoice correction reason is missing from this site. Add a return reason with the code CORRECTION in Setup, then try again.',
    }
  }

  const credit = await createCreditNote(siteId, actor, {
    invoiceId: original.id,
    customerId: original.customerId,
    customerName: original.customerName,
    reasonId: correctionReason.id,
    note: input.reason.trim(),
    reasonPrefix: 'Correction',
    // Retired is fine here: the SYSTEM chose this code, so a site tidying its
    // returns list must not be able to break invoice editing.
    allowRetiredReason: true,
    lines: original.lines.map((line) => ({
      sourceLineId: line.id,
      productId: line.productId,
      productCode: line.productCode,
      description: line.description,
      productType: line.productType,
      departmentId: line.departmentId,
      qty: Math.abs(line.qty),
      unitPriceIncl: line.unitPriceIncl,
      vatRatePct: line.vatRatePct,
      // From the ORIGINAL line, never re-read from the product. Reversing at
      // today's cost would manufacture margin that was never earned.
      unitCostExcl: line.unitCostExcl,
    })),
    terminalId: original.terminalId,
    terminalCode: original.terminalCode,
    refunds: input.refunds,
  })

  if (!credit.ok) {
    return { ok: false, error: `The original could not be reversed: ${credit.error}` }
  }

  // ── 2. Repost the corrected version as an ordinary new invoice, so every
  //       finalise guard runs again on it. If this fails the customer holds an
  //       invoice and its matching credit note — a correct net zero.
  const draft = await saveDraft(siteId, actor, {
    docType: 'invoice',
    customerId: input.customerId ?? original.customerId,
    customerName: original.customerName,
    customerVatNo: original.customerVatNo,
    customerPhone: original.customerPhone,
    customerAddress: original.customerAddress,
    priceStructureId: original.priceStructureId,
    terminalId: original.terminalId,
    terminalCode: original.terminalCode,
    reference: original.reference,
    notes: `Corrected — replaces ${original.documentNumber}, reversed by ${credit.documentNumber}. ${input.reason.trim()}`.slice(0, 400),
    lines: input.lines,
  })
  if (!draft.ok) {
    return {
      ok: false,
      error: `The original was reversed by ${credit.documentNumber}, but the corrected invoice could not be saved: ${draft.error}`,
      suggestion: 'Ring the corrected sale up as a new invoice.',
    }
  }

  const posted = await finaliseDocument(siteId, actor, {
    documentId: draft.id,
    customerId: input.customerId ?? original.customerId,
    tenders: input.tenders,
  })
  if (!posted.ok) {
    return {
      ok: false,
      error: `The original was reversed by ${credit.documentNumber}, but the corrected invoice could not be posted: ${posted.error}`,
      suggestion: 'Ring the corrected sale up as a new invoice.',
    }
  }

  // Audit rows on all three, so any of them explains the other two.
  await Promise.all([
    audit(siteId, actor, original.id, 'edited',
      `Corrected — reversed by ${credit.documentNumber}, replaced by ${posted.documentNumber}. ${input.reason.trim()}`),
    audit(siteId, actor, credit.documentId, 'reversal',
      `Reverses ${original.documentNumber} for correction`),
    audit(siteId, actor, posted.documentId, 'correction',
      `Replaces ${original.documentNumber}, reversed by ${credit.documentNumber}`),
  ])

  return {
    ok: true,
    documentId: posted.documentId,
    documentNumber: posted.documentNumber,
    creditNoteId: credit.documentId,
    creditNoteNumber: credit.documentNumber,
    replacedNumber: original.documentNumber!,
  }
}

export type CorrectionChain = {
  /** The credit note that reversed this document, if it was corrected. */
  reversedBy: { id: number; documentNumber: string | null } | null
  /** True when this document IS a correction of an earlier one. */
  isCorrection: boolean
  correctedAt: Date | null
  correctedBy: string | null
  reason: string | null
}

/**
 * The correction story for a document, for the banner on its detail screen.
 *
 * Read from `document_audit` rather than a stored link, because the three
 * documents are ordinary documents and giving them special columns would push
 * correction-awareness into every query that touches a sale.
 */
export async function correctionChain(
  siteId: number,
  documentId: number,
): Promise<CorrectionChain> {
  const [audits, replacedByRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT action, detail, user_name, created_at
         FROM document_audit
        WHERE document_id = ? AND action IN ('edited','correction','reversal')
        ORDER BY id DESC`,
      [documentId],
    ),
    // A document this one replaced is found through the credit note that
    // reverses it: the correction wrote its number into the replacement's
    // notes, but the reliable link is the credit note's reverses_id.
    siteQueryOne<Row>(
      siteId,
      `SELECT d.id, d.document_number
         FROM sales_documents d
        WHERE d.reverses_id = ? AND d.doc_type = 'credit_sale' AND d.status = 'finalised'
        ORDER BY d.id DESC LIMIT 1`,
      [documentId],
    ),
  ])

  const edited = audits.find((a) => String(a.action) === 'edited')
  const correction = audits.find((a) => String(a.action) === 'correction')

  return {
    reversedBy: replacedByRow
      ? { id: Number(replacedByRow.id), documentNumber: (replacedByRow.document_number as string | null) ?? null }
      : null,
    isCorrection: correction !== undefined,
    correctedAt: (edited?.created_at as Date | null) ?? (correction?.created_at as Date | null) ?? null,
    correctedBy: edited ? String(edited.user_name) : correction ? String(correction.user_name) : null,
    reason: edited ? String(edited.detail ?? '') : correction ? String(correction.detail ?? '') : null,
  }
}

/**
 * "Edit details" — the safe subset.
 *
 * Notes, reference and the printed contact details carry no financial or
 * legal weight, so they can be changed in place on a finalised document
 * without reversing anything. The plan recommends shipping THIS before
 * supervisor edit, because it covers a surprising share of what people
 * actually want "edit" for.
 *
 * Deliberately cannot touch: the document number, the date, any line, any
 * amount, the customer, or the VAT. Those are what reverse-and-repost is for.
 */
export async function editDocumentDetails(
  siteId: number,
  actor: Actor,
  documentId: number,
  changes: {
    reference?: string | null
    notes?: string | null
    customerPhone?: string | null
    customerAddress?: string | null
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const document = await getDocument(siteId, documentId)
  if (!document) return { ok: false, error: 'That document no longer exists.' }
  if (document.status === 'cancelled') {
    return { ok: false, error: 'A voided document cannot be changed.' }
  }

  const before = {
    reference: document.reference,
    notes: document.notes,
    customerPhone: document.customerPhone,
    customerAddress: document.customerAddress,
  }

  await siteQuery(
    siteId,
    `UPDATE sales_documents
        SET reference = ?, notes = ?, customer_phone = ?, customer_address = ?
      WHERE id = ?`,
    [
      changes.reference?.trim() || null,
      changes.notes?.trim() || null,
      changes.customerPhone?.trim() || null,
      changes.customerAddress?.trim() || null,
      documentId,
    ],
  )

  const changed = Object.entries(changes)
    .filter(([key, value]) => (value ?? null) !== (before[key as keyof typeof before] ?? null))
    .map(([key]) => key)

  if (changed.length > 0) {
    await audit(siteId, actor, documentId, 'details_edited',
      `Changed ${changed.join(', ')} — no financial figure was touched`)
  }

  return { ok: true }
}

async function audit(
  siteId: number,
  actor: Actor,
  documentId: number,
  action: string,
  detail: string,
): Promise<void> {
  try {
    await siteQuery(
      siteId,
      `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, ?, ?, ?, ?)`,
      [documentId, action, detail.slice(0, 400), actor.userId, actor.userName.slice(0, 120)],
    )
  } catch {
    // The write it describes has already committed; failing here would undo a
    // correct operation to record a note about it.
  }
}
