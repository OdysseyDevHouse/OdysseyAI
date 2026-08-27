'use server'

import { revalidatePath } from 'next/cache'
import { requireCapability } from '@/lib/auth'
import { toggleFavorite } from '@/lib/site/reportFavorites'
import { deleteSavedReport } from '@/lib/site/savedReports'
import { loadSaleRecord, type SaleRecordSnapshot } from '@/lib/site/saleRecord'
import { getDocument } from '@/lib/site/salesDocuments'
import { getCustomer } from '@/lib/site/customers'
import { lastEmailed } from '@/lib/site/invoiceEmail'
import { isConfigured as mailIsConfigured } from '@/lib/mail'

/**
 * Hub actions.
 *
 * Each one re-checks its own capability. A server action is a public HTTP
 * endpoint — the fact that the button rendering it was hidden proves nothing
 * about who is calling.
 */

export type ActionResult = { ok: true } | { ok: false; error: string }

/** Deleting also cancels any schedule pointing at the report — the caller says so. */
export type DeleteResult = { ok: true; schedulesRemoved: number } | { ok: false; error: string }

export async function toggleFavoriteAction(reportId: string): Promise<ActionResult> {
  const { siteId, actor } = await requireCapability('reports.view')
  if (!reportId || reportId.length > 64) return { ok: false, error: 'Unknown report.' }

  try {
    await toggleFavorite(siteId, actor.userId, reportId)
    return { ok: true }
  } catch {
    return { ok: false, error: 'Could not save that favourite. Try again.' }
  }
}

export async function deleteSavedReportAction(id: number): Promise<DeleteResult> {
  // Deleting a report everyone can see is an edit to shared state, so it needs
  // the build permission rather than the view one.
  const { siteId } = await requireCapability('reports.build')
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Unknown report.' }

  try {
    const schedulesRemoved = await deleteSavedReport(siteId, id)
    revalidatePath('/reports')
    revalidatePath('/reports/schedules')
    // The caller surfaces this: silently cancelling someone's scheduled email is
    // exactly the kind of side effect that erodes trust in the feature.
    return { ok: true, schedulesRemoved }
  } catch {
    return { ok: false, error: 'Could not delete that report. Try again.' }
  }
}

/**
 * The sale behind a document number in a report.
 *
 * Reports are a READING surface, so a clicked invoice number opens the record
 * rather than navigating to it — the reader keeps their period, their filters
 * and their scroll position, which is the whole reason the number is a cell and
 * not a link out.
 *
 * ── WHY ITS OWN ACTION ────────────────────────────────────────────────────
 *
 * `saleRecordAction` in (invoicing) does the same read, but it is that route's
 * own action and asks the invoicing capability chain for its actor. This one
 * belongs to the reports surface and states its own gate.
 *
 * ── THE GATE IS sales.view, NOT reports.view ──────────────────────────────
 *
 * Deliberately the STRICTER of the two, and not the one that got the reader
 * here. Somebody who may read a turnover figure has not thereby been given the
 * right to read every customer name, line and tender on an individual sale;
 * those are two different disclosures. A reader without it sees the number as
 * plain text — the cell simply does not become a button, and the action refuses
 * regardless of what the cell rendered, because a hidden control is not a
 * boundary.
 */
export async function reportSaleRecordAction(
  documentId: number,
): Promise<SaleRecordSnapshot | null> {
  const { siteId } = await requireCapability('sales.view')
  if (!Number.isInteger(documentId) || documentId <= 0) return null
  return loadSaleRecord(siteId, documentId)
}

/**
 * What the report's document dialog needs to OFFER emailing, beside the record.
 *
 * The record itself carries nothing about who to send to: `SaleRecordSnapshot`
 * is the reading shape three surfaces share, and a customer's email address is
 * not part of reading a sale. So the dialog asks for these separately, exactly
 * as `DocumentActionBar` resolves them for the sale's own screen — same facts,
 * resolved on the server, so the report and that screen can never disagree
 * about whether a document may be emailed.
 *
 * `emailable` is false on anything that is not a finalised invoice or credit
 * note: a quote or a cancelled sale has nothing a customer should be sent.
 */
export type ReportSaleEmailContext = {
  emailable: boolean
  /** False shows the button disabled with the reason, never a dead dialog. */
  mailConfigured: boolean
  /** The customer's address, empty on a walk-in or an account without one. */
  defaultTo: string
  /** The last 'emailed' audit entry, for informed resends. */
  lastEmailedNote: string | null
}

export async function reportSaleEmailContextAction(
  documentId: number,
): Promise<ReportSaleEmailContext | null> {
  /* The same gate as the record read beside it: somebody who may not read the
     sale has no business learning its customer's email address. Sending is
     gated separately, and more strictly, by emailInvoiceAction itself — this
     one only decides whether to OFFER it. */
  const { siteId } = await requireCapability('sales.view')
  if (!Number.isInteger(documentId) || documentId <= 0) return null

  const document = await getDocument(siteId, documentId)
  if (!document) return null

  const emailable =
    document.status === 'finalised' &&
    (document.docType === 'invoice' || document.docType === 'credit_sale')

  /* Answered without the two extra reads when there is nothing to send. */
  if (!emailable) {
    return {
      emailable: false,
      mailConfigured: mailIsConfigured(),
      defaultTo: '',
      lastEmailedNote: null,
    }
  }

  const [customer, lastSend] = await Promise.all([
    document.customerId ? getCustomer(siteId, document.customerId) : Promise.resolve(null),
    lastEmailed(siteId, documentId),
  ])

  return {
    emailable: true,
    mailConfigured: mailIsConfigured(),
    defaultTo: customer?.email ?? '',
    lastEmailedNote: lastSend ? `${lastSend.detail ?? ''} · ${lastSend.userName}` : null,
  }
}
