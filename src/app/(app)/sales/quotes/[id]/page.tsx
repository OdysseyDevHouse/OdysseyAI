import { notFound, redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { getDocument, isEditable } from '@/lib/site/salesDocuments'
import { getQuote } from '@/lib/site/quotes'
import { listPriceStructures } from '@/lib/site/lookups'
import { listUsers } from '@/lib/site/users'
import { can } from '@/lib/site/permissions'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { getNumericSetting } from '@/lib/site/settings'
import { getTillCustomer } from '@/lib/site/tillCustomers'
import InvoiceEditor from '../../invoicing/[id]/InvoiceEditor'
import { QuotePanel } from './QuotePanel'

export const dynamic = 'force-dynamic'

/**
 * The quote editor.
 *
 * ── THE SAME EDITOR AS AN INVOICE ────────────────────────────────────────
 *
 * Literally: it imports InvoiceEditor. A quote has a customer, lines, prices,
 * VAT and a total, all computed by the same documentMath — so capturing one is
 * the same job, and a second editor would be a second place for a line total to
 * be worked out differently.
 *
 * The editor branches on document.docType for the two things that differ: the
 * primary action issues rather than takes payment, and the noun changes.
 * Everything a quote has that an invoice does not — validity, outcome,
 * conversion — sits in the panel above it rather than inside the shared grid.
 */
export default async function QuoteEditorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { site, capabilities } = await requireSiteUser()
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  const [document, quote, structures, users, tenders, cashRounding] = await Promise.all([
    getDocument(site.id, documentId),
    getQuote(site.id, documentId),
    listPriceStructures(site.id),
    listUsers(site.id),
    listTenderTypes(site.id),
    getNumericSetting(site.id, 'sales_cash_rounding'),
  ])

  if (!document) notFound()
  // Opened by document id rather than through the list: send an invoice to the
  // screen that owns it rather than showing it in quote clothing.
  if (document.docType !== 'quote') redirect(`/sales/invoicing/${documentId}`)
  if (!quote) notFound()

  const reps = users
    .filter((u) => u.isActive)
    .map((u) => ({ id: u.id, name: u.name, code: null }))

  const customer = document.customerId
    ? await getTillCustomer(site.id, document.customerId)
    : null

  return (
    <>
      <QuotePanel
        quote={{
          id: quote.id,
          documentNumber: quote.documentNumber,
          state: quote.state,
          validUntil: quote.validUntil,
          daysRemaining: quote.daysRemaining,
          outcome: quote.outcome,
          lostReason: quote.lostReason,
          convertedToId: quote.convertedToId,
          convertedToNumber: quote.convertedToNumber,
          totalIncl: quote.totalIncl,
        }}
        canEdit={can(capabilities, 'sales.edit')}
      />

      <InvoiceEditor
        document={document}
        structures={structures}
        reps={reps}
        tenders={tenders}
        cashRounding={cashRounding}
        customer={customer}
        // A quote stays editable while it is open. Once accepted it is the
        // record of what was offered, and the invoice it became is where any
        // change belongs.
        editable={isEditable(document.status) && quote.outcome === 'open'}
        canOverrideDiscount={can(capabilities, 'sales.discount_override')}
      canOverridePrice={can(capabilities, 'sales.price_override')}
      showCost={can(capabilities, 'products.cost')}
      />
    </>
  )
}
