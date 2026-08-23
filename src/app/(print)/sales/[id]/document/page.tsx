import './document-a4.css'
import { qrContextFor } from '@/lib/site/qrLinks'
import { pictureIds } from '@/lib/site/stationeryImages'
import { notFound } from 'next/navigation'
import { requireSite, requireCapability } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { getQuote } from '@/lib/site/quotes'
import { getOrder } from '@/lib/site/salesOrders'
import { recordPrint } from '@/lib/site/salesPosting'
import { printKindFor, HEADING, CLOSING } from '@/lib/site/salesDocumentKind'
import { activeTemplate } from '@/lib/site/stationeryTemplates'
import { bankingDetails } from '@/lib/invoices/build'
import { invoiceTokens } from '@/lib/stationery/adapters/invoice'
import { renderTemplate } from '@/lib/stationery/render'
import { resolveTemplate } from '@/lib/stationery/resolve'
import { logoImgTag } from '@/lib/site/documentLogo'
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
 *
 * `?auto=1` prints once on mount — the trade counter's Print button opened this
 * tab to put paper in a customer's hand, not to be read. The same flag the slip
 * route carries, for the same reason and with the same default: without it the
 * page waits, because a pro forma is usually opened to CHECK it first.
 */
export default async function SalesDocumentPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ auto?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { capabilities } = await requireCapability('sales.view')
  const site = await requireSite()
  const { id: raw } = await params
  const { auto } = await searchParams

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const doc = await getDocument(site.id, id)
  if (!doc) notFound()
  /*
   * Every sales document that has a paper form. A credit note was missing, so
   * the Print button on the sale screen offered it and the route 404'd — see
   * printKindFor for why it could not simply be allowed through before.
   */
  const PRINTABLE = ['quote', 'sales_order', 'invoice', 'credit_sale']
  if (!PRINTABLE.includes(doc.docType)) notFound()

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

  /*
   * ── COMPOSED FROM A TEMPLATE, NOT FROM A COMPONENT ──────────────────────
   *
   * The same swap the purchase order made, and the reason is the same: a shop
   * can change what its customers see without a deployment. Until this, a shop
   * could design an invoice in Setup → Stationery, save it, and print the
   * shipped layout anyway — the design reached the database and never the paper,
   * which is the worst kind of half-built feature because it looks finished.
   *
   * resolveTemplate falls back to the shipped default when the site has designed
   * nothing, and SKIPS a template that no longer validates rather than printing
   * it. A plain document beats a wrong one, and an invoice missing what the VAT
   * Act asks for is a wrong one.
   *
   * ── ONE TEMPLATE FOR FOUR DOCUMENTS ─────────────────────────────────────
   *
   * Quotes, sales orders, pro formas and tax invoices all print through here and
   * all resolve the 'invoice' template. What differs between them is words and
   * dates, and both arrive as TOKENS: {doc.heading} says QUOTATION or TAX
   * INVOICE, {doc.closing} carries the warning a quote needs and nothing on an
   * invoice, and the three date rows each print only on the kind they belong to
   * because a detail list drops a row whose value is empty.
   *
   * So a shop designs its stationery once and every one of the four follows.
   */
  const [custom, banking, logoHtml] = await Promise.all([
    activeTemplate(site.id, 'invoice'),
    // The cashbook's nominated receipts account — see bankingDetails. Never
    // allowed to break the page: a document that will not print is worse than
    // one printed without a banking block.
    bankingDetails(site.id).catch(() => null),
    logoImgTag(site.id).catch(() => ''),
  ])

  const template = resolveTemplate('invoice', custom?.body ?? null, custom?.format)
  const input = invoiceTokens({
    doc,
    site: {
      name: site.displayName,
      vatNumber: site.vatNumber,
      registrationNumber: site.registrationNumber,
      address1: site.address1,
      address2: site.address2,
      address3: site.address3,
      postalCode: site.postalCode,
      phone: site.phone,
      email: site.email,
    },
    banking,
    printedAt,
    logoHtml,
    // The route already decided what this paper is called; deriving it a second
    // time inside the adapter would be a second answer to the same question.
    heading: HEADING[kind],
    closing: CLOSING[kind],
    validUntil,
    deliveryDate,
    customerOrderNo,
    isReprint,
  })

  const html = renderTemplate(template.body, 'invoice', {
    ...input,
    capabilities,
    pictures: await pictureIds(site.id),
    qr: await qrContextFor(site.id),
  })

  return (
    <div className="px-6 py-6">
      <DocumentPrintButton doc={{ id: doc.id, docType: doc.docType }} auto={auto === '1'} />
      {/* Sanitised at save and re-validated at resolve; the values inside it are
          escaped by the renderer. See lib/stationery/sanitise.ts. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
