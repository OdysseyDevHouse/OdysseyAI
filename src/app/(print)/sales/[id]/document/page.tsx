import './document-a4.css'
import { notFound } from 'next/navigation'
import { requireSite, requireCapability } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { getQuote } from '@/lib/site/quotes'
import { getOrder } from '@/lib/site/salesOrders'
import { recordPrint } from '@/lib/site/salesPosting'
import { SalesDocumentPrint, printKindFor } from '@/components/sales/SalesDocumentPrint'
import DocumentPrintButton from './DocumentPrintButton'

export const dynamic = 'force-dynamic'

/**
 * The printable customer-facing document — quote, sales order, pro forma or
 * tax invoice.
 *
 * ── ONE ROUTE FOR THE THREE DOCUMENT TYPES ────────────────────────────────
 *
 * The same reason one editor captures all three: they are one document at
 * different moments, and a second route would be a second place for a total to
 * be printed differently from the one on the screen. What the paper is called
 * is decided by `printKindFor` from doc type and status — never by a query
 * parameter, so no link can ask an unfinalised invoice to print itself as a
 * tax invoice.
 *
 * Its own route in the bare (print) group rather than a modal, so the browser
 * prints the DOCUMENT and not the application around it — the same reason the
 * purchase order and the lay-by agreement have one.
 *
 * A CREDIT NOTE is not here. It reverses a sale rather than asking for one,
 * and printing it under any of these four headings would misdescribe it, so it
 * 404s until it has an instrument of its own.
 */
export default async function SalesDocumentPrintPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('sales.view')
  const site = await requireSite()
  const { id: raw } = await params

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const doc = await getDocument(site.id, id)
  if (!doc) notFound()
  if (doc.docType !== 'quote' && doc.docType !== 'sales_order' && doc.docType !== 'invoice') {
    notFound()
  }

  const kind = printKindFor(doc)

  /*
   * Whether this is a reprint, decided BEFORE this print is counted.
   *
   * The question the paper answers is "has this invoice been on paper
   * before?", so a first print must not call itself a reprint on the strength
   * of the row it is about to write.
   */
  const isReprint = doc.printCount > 0

  /*
   * Counting the print, for FINALISED invoices only.
   *
   * Rendering the page IS the print: there is no way to know whether the
   * browser dialog was confirmed, so the honest thing to record is that the
   * document was pulled up for printing — which is the fact anyone querying a
   * duplicate payment actually needs.
   *
   * Quotes, orders and pro formas are excluded because they are EXPECTED to be
   * printed repeatedly while they are being revised. Counting those would make
   * the tax invoice's own count — the one that answers "did this go out
   * twice?" — meaningless.
   *
   * Never allowed to break the page: an invoice that will not print because a
   * counter column is missing is a worse failure than a wrong number in it.
   */
  if (kind === 'tax_invoice') {
    await recordPrint(site.id, doc.id).catch(() => {})
  }

  /*
   * The one fact each kind adds that the document row does not carry.
   *
   * Read only for the kind that needs it: a quote's expiry lives in
   * sales_quotes and an order's delivery date in sales_order_details, and
   * fetching both for every print would be two queries to throw one away.
   * Both are tolerant of a miss — a document that prints without its date is
   * better than one that does not print.
   */
  let validUntil: string | null = null
  let deliveryDate: string | null = null
  let customerOrderNo: string | null = null

  if (kind === 'quote') {
    const quote = await getQuote(site.id, id).catch(() => null)
    validUntil = quote?.validUntil ?? null
  } else if (kind === 'sales_order') {
    const order = await getOrder(site.id, id).catch(() => null)
    deliveryDate = order?.details?.deliveryDate ?? null
    customerOrderNo = order?.details?.customerOrderNo ?? null
  }

  const printedAt = new Date().toLocaleString('en-ZA', {
    dateStyle: 'short',
    timeStyle: 'short',
  })

  return (
    <div className="px-6 py-6">
      <DocumentPrintButton doc={{ id: doc.id, docType: doc.docType }} />
      <SalesDocumentPrint
        doc={doc}
        kind={kind}
        site={{
          name: site.displayName,
          vatNumber: site.vatNumber,
          registrationNumber: site.registrationNumber,
          address1: site.address1,
          address2: site.address2,
          address3: site.address3,
          postalCode: site.postalCode,
          phone: site.phone,
          email: site.email,
        }}
        validUntil={validUntil}
        deliveryDate={deliveryDate}
        customerOrderNo={customerOrderNo}
        printedAt={printedAt}
        isReprint={isReprint}
      />
    </div>
  )
}
