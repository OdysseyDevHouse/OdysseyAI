import 'server-only'
import { round } from '../decimals'
import { getSupplier } from '../site/suppliers'
import { listPaymentItems, getPaymentRun } from '../site/paymentRuns'
import type { StatementData } from './render'

/**
 * A remittance advice — "here is what we paid you, against these invoices".
 *
 * Builds the SAME StatementData shape the debtors statement uses, so the
 * document component and the PDF renderer are reused unchanged. That is the
 * shared-vs-duplicated line from the plan, tested: anything that renders money
 * or a ledger line is one implementation, and only what decides the content is
 * written twice.
 *
 * The lines are the invoices being settled, not a period of activity. A
 * remittance answers one question — "what does this payment cover" — and the
 * supplier reads it beside their own open-item list.
 */
export async function buildRemittance(
  siteId: number,
  siteName: string,
  siteVatNumber: string | null,
  runId: number,
  supplierId: number,
): Promise<StatementData | null> {
  const [run, items, supplier] = await Promise.all([
    getPaymentRun(siteId, runId),
    listPaymentItems(siteId, runId),
    getSupplier(siteId, supplierId),
  ])
  if (!run || !supplier) return null

  const item = items.find((i) => i.supplierId === supplierId)
  if (!item) return null

  // Each allocation becomes a line: what the invoice was, and what this payment
  // is putting against it. A part-payment shows both figures, which is exactly
  // what stops a supplier assuming the invoice is settled in full.
  const lines = item.allocations.map((allocation) => ({
    date: allocation.docDate ?? run.paymentDate,
    docType: 'Invoice',
    docNumber: allocation.docNumber,
    description:
      allocation.amount < allocation.docAmount - 0.005
        ? `Part payment of ${allocation.docAmount.toFixed(2)}`
        : 'Settled in full',
    reference: null,
    debit: allocation.docAmount,
    credit: allocation.amount,
    // What is left on that invoice after this payment.
    outstanding: round(allocation.docAmount - allocation.amount, 2),
    daysOverdue: 0,
    balance: allocation.amount,
  }))

  return {
    format: 'open-item',
    site: { name: siteName, vatNumber: siteVatNumber },
    account: {
      id: supplier.id,
      code: supplier.accountNumber ?? supplier.code,
      name: supplier.name,
      contactName: supplier.contactName,
      email: supplier.email,
      phone: supplier.phone,
      vatNumber: supplier.vatNumber,
      addressLines: [
        supplier.addressLine1,
        supplier.addressLine2,
        [supplier.city, supplier.postalCode].filter(Boolean).join(' ') || null,
      ].filter((l): l is string => Boolean(l)),
      creditLimit: 0,
      paymentTermsDays: supplier.paymentTermsDays,
    },
    period: { from: run.paymentDate, to: run.paymentDate },
    openingBalance: 0,
    // On a remittance this is the amount PAID, which is what the document
    // labels it — see the variant handling in StatementDocument.
    closingBalance: item.amount,
    lines,
    // No ageing on a remittance: it is a payment advice, not a demand.
    aging: { current: 0, d30: 0, d60: 0, d90: 0, d120: 0, total: 0 },
    dueNow: 0,
    generatedAt: new Date(),
  }
}

/** Suppliers in a run that can actually be emailed a remittance. */
export async function remittanceRecipients(siteId: number, runId: number) {
  const items = await listPaymentItems(siteId, runId)
  return items.map((item) => ({
    supplierId: item.supplierId,
    code: item.supplierCode,
    name: item.supplierName,
    email: item.email,
    amount: item.amount,
    status: item.remittanceStatus,
    error: item.remittanceError,
    sentAt: item.remittanceSentAt,
    invoiceCount: item.allocations.length,
  }))
}
