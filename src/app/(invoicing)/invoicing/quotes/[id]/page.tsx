import { notFound, redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { getDocument, isEditable } from '@/lib/site/salesDocuments'
import { liveSpecials } from '@/lib/site/specials'
import { getQuote } from '@/lib/site/quotes'
import { listPriceStructures, repsForLines } from '@/lib/site/lookups'
import { listUsers } from '@/lib/site/users'
import { can } from '@/lib/site/permissions'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { getNumericSetting } from '@/lib/site/settings'
import { getTillCustomer } from '@/lib/site/tillCustomers'
import InvoiceEditor from '@/app/(invoicing)/invoicing/[id]/InvoiceEditor'
import { QuotePanel } from './QuotePanel'
import { QuoteValidUntilField } from './QuoteValidUntilField'
import { depositSummary } from '@/lib/site/deposits'
import { DepositPanel } from '@/app/(app)/sales/DepositPanel'

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
  const { site, user, capabilities } = await requireSiteUser()
  const { id } = await params

  const documentId = Number(id)
  if (!Number.isFinite(documentId) || documentId <= 0) notFound()

  const [document, quote, structures, users, tenders, cashRounding, specials, deposits] =
    await Promise.all([
    getDocument(site.id, documentId),
    getQuote(site.id, documentId),
    listPriceStructures(site.id),
    listUsers(site.id),
    listTenderTypes(site.id),
    getNumericSetting(site.id, 'sales_cash_rounding'),
    // A quote is priced like an invoice, so it sees the same promotions.
    liveSpecials(site.id),
    // Money held to secure this quote (172). It follows the quote onto the
    // invoice when it converts — see convertToInvoice.
    depositSummary(site.id, documentId),
  ])

  if (!document) notFound()
  // Opened by document id rather than through the list: send an invoice to the
  // screen that owns it rather than showing it in quote clothing.
  if (document.docType !== 'quote') redirect(`/invoicing/${documentId}`)
  if (!quote) notFound()

  // Whoever is capturing is pre-selected on every new line, as on an invoice —
  // a quote becomes one, and the attribution carries with it.
  const { reps, defaultUserId } = repsForLines(users, user.id)

  const customer = document.customerId
    ? await getTillCustomer(site.id, document.customerId)
    : null

  return (
    <>
      <InvoiceEditor
        document={document}
        structures={structures}
        reps={reps}
        defaultRepUserId={defaultUserId}
        tenders={tenders}
        cashRounding={cashRounding}
        specials={specials}
        customer={customer}
        // A quote stays editable while it is open. Once accepted it is the
        // record of what was offered, and the invoice it became is where any
        // change belongs.
        editable={isEditable(document.status) && quote.outcome === 'open'}
        /*
          "Valid until", in the document header rather than the panel below.
          It is captured alongside the date and the customer's reference — the
          same breath — so it belongs in that card; the panel keeps what was
          DECIDED about the quote. Only while it can still be changed: a
          decided quote's validity is history, and QuotePanel prints it as a
          plain line in that case.
        */
        detailsSlot={
          quote.outcome === 'open' && can(capabilities, 'sales.edit') ? (
            <QuoteValidUntilField
              quoteId={quote.id}
              validUntil={quote.validUntil}
              daysRemaining={quote.daysRemaining}
              showDaysLeft={quote.state === 'open'}
            />
          ) : null
        }
        canOverrideDiscount={can(capabilities, 'sales.discount_override')}
        canOverridePrice={can(capabilities, 'sales.price_override')}
        showCost={can(capabilities, 'products.cost')}
        /* The outcome and deposit panels follow below, so the editor must not
           close the page with its own pb-10. */
        hasSectionsBelow
      />

      {/*
        ── VALIDITY AND OUTCOME, BELOW THE DOCUMENT ────────────────────────

        This used to render FIRST, which put "Valid until" in a card above the
        quote's own heading and back arrow — so the first thing on the screen
        was a detail about the document, before the document had been named.

        It belongs after the lines for the same reason the deposit panel does:
        the lines are the work, and validity, outcome and conversion are what
        you decide once you have read them.

        Both trailing sections share ONE block wearing PageBody's own numbers —
        `px-6 pt-5 pb-10 gap-5` — rather than each bringing its own padding.
        Separate wrappers put `pt-4` under the editor's `pb-10` and then `pt-5`
        again before the deposit, so the two seams below the grid were three
        times the gap used everywhere else and the screen came apart at them.
        The editor is told `hasSectionsBelow`, which drops its trailing
        `pb-10`, so every seam here is the same 20px.
      */}
      <div className="flex flex-col gap-5 px-6 pt-5 pb-10">
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

        {/* Money put down to secure this quote. Below the grid for the same
            reason as on an invoice: the lines are the work, the deposit is the
            check.

            Editable while the quote is still open — once it is accepted the
            deposit belongs to the invoice it became, and is managed there. */}
        <DepositPanel
          documentId={documentId}
          docType="quote"
          status={document.status}
          totalIncl={deposits.totalIncl}
          held={deposits.held}
          entries={deposits.entries}
          hasCustomer={document.customerId !== null}
          canEdit={
            can(capabilities, 'sales.edit') &&
            isEditable(document.status) &&
            quote.outcome === 'open'
          }
        />
      </div>
    </>
  )
}
