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
  //
  // SETTLEMENT DISCOUNT is stated explicitly on the line it was taken on. It
  // must be: from the supplier's side an invoice for R1 000 paid at R980 looks
  // like a R20 short payment, and an advice that does not say "we took the 2%
  // you offered" is the one that generates a query — or worse, a statement
  // showing R20 still owing that nobody can reconcile.
  const lines = item.allocations.map((allocation) => {
    const discount = allocation.discountAmount ?? 0
    const settled = round(allocation.amount + discount, 2)
    const outstanding = round(allocation.docAmount - settled, 2)

    return {
      date: allocation.docDate ?? run.paymentDate,
      docType: 'Invoice',
      docNumber: allocation.docNumber,
      description:
        discount > 0
          ? outstanding > 0.005
            ? `Part payment; ${discount.toFixed(2)} settlement discount taken`
            : `Settled in full, less ${discount.toFixed(2)} settlement discount`
          : outstanding > 0.005
            ? `Part payment of ${allocation.docAmount.toFixed(2)}`
            : 'Settled in full',
      reference: null,
      debit: allocation.docAmount,
      credit: allocation.amount,
      // What is left after BOTH the payment and the discount. Without counting
      // the discount this reads as unpaid on an invoice that is closed.
      outstanding,
      daysOverdue: 0,
      balance: allocation.amount,
    }
  })

  // A discount is a real reduction in what we paid, so the advice has to
  // reconcile: invoices less discount equals the amount transferred.
  const discountTotal = item.allocations.reduce(
    (sum, a) => round(sum + (a.discountAmount ?? 0), 2),
    0,
  )

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
    settlementDiscount: discountTotal > 0 ? discountTotal : undefined,
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
