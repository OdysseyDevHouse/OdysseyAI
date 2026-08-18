import 'server-only'
import { getDocument } from '@/lib/site/salesDocuments'
import { creditNotesFor } from '@/lib/site/salesReversal'
import { siteQuery } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import type { SaleRecordData } from '@/app/(app)/sales/[id]/SaleRecord'

/**
 * Everything the sale record screen shows, as one flat, serialisable object.
 *
 * The record page used to read the document, its credit notes and its tenders
 * inline. It is now read here instead, because the invoicing screen wants the
 * SAME record in the dialog it shows the moment an invoice posts — and a client
 * dialog can only be handed data, not a query. One reader means the two can
 * never drift into showing different things about the same sale.
 */
export type SaleRecordSnapshot = SaleRecordData & {
  id: number
  documentNumber: string | null
  docLabel: string
  documentDate: string
}

export async function loadSaleRecord(
  siteId: number,
  documentId: number,
): Promise<SaleRecordSnapshot | null> {
  const document = await getDocument(siteId, documentId)
  if (!document) return null

  const [credits, tenderRows] = await Promise.all([
    creditNotesFor(siteId, documentId),
    siteQuery<Record<string, unknown>>(
      siteId,
      'SELECT tender_name, amount, change_given, reference FROM sales_tenders WHERE document_id = ? ORDER BY id',
      [documentId],
    ),
  ])

  return {
    id: document.id,
    documentNumber: document.documentNumber,
    docLabel: document.docLabel,
    documentDate: document.documentDate,
    status: document.status,
    /* Formatted here rather than shipped as a Date: the dialog receiving this
       over a server action would get a string anyway, and two callers agreeing
       on the format beats each inventing one. */
    cancelledAt: document.cancelledAt
      ? document.cancelledAt.toLocaleDateString('en-ZA')
      : null,
    cancelReason: document.cancelReason,
    subtotalExcl: document.subtotalExcl,
    vatTotal: document.vatTotal,
    discountTotal: document.discountTotal,
    roundingAdj: document.roundingAdj,
    totalIncl: document.totalIncl,
    changeGiven: document.changeGiven,
    customerName: document.customerName,
    userName: document.userName,
    terminalCode: document.terminalCode,
    reference: document.reference,
    printCount: document.printCount,
    lines: document.lines.map((line) => ({
      id: line.id,
      description: line.description,
      productCode: line.productCode,
      discountPct: line.discountPct,
      vatRatePct: line.vatRatePct,
      qty: line.qty,
      unitPriceIncl: line.unitPriceIncl,
      lineTotalIncl: line.lineTotalIncl,
      note: line.note,
      instructions: line.instructions.map((c) => ({
        id: c.id,
        optionName: c.optionName,
        qty: c.qty,
        lineAdjustIncl: c.lineAdjustIncl,
      })),
    })),
    tenders: tenderRows.map((t) => ({
      name: String(t.tender_name),
      reference: (t.reference as string | null) ?? null,
      amount: toNum(t.amount),
    })),
    credits: credits.map((c) => ({
      id: c.id,
      documentNumber: c.documentNumber,
      total: c.total,
      reason: c.reason,
    })),
  }
}
