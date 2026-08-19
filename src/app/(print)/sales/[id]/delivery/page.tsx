import '../document/document-a4.css'
import { notFound } from 'next/navigation'
import { requireSite, requireCapability } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { getOrderDetails } from '@/lib/site/salesOrders'
import { defaultAddressFor } from '@/lib/site/customerAddresses'
import { activeTemplate } from '@/lib/site/stationeryTemplates'
import { logoImgTag } from '@/lib/site/documentLogo'
import { deliveryNoteTokens } from '@/lib/stationery/adapters/deliveryNote'
import { renderTemplate } from '@/lib/stationery/render'
import { resolveTemplate } from '@/lib/stationery/resolve'
import DocumentPrintButton from '../document/DocumentPrintButton'

export const metadata = { title: 'Delivery note' }

/**
 * The paper that travels with the goods.
 *
 * ── A SEPARATE ROUTE, NOT A MODE OF THE INVOICE ───────────────────────────
 *
 * It would have been fewer files to add `?as=delivery` to the sales document
 * route. It is a different DOCUMENT, though, with its own token catalog that
 * contains no money at all — and sharing a route means sharing the catalog,
 * which is the one thing that must not happen here. A price on the driver's
 * copy is a commercial leak, and the way to make it impossible rather than
 * merely absent is to give the document its own type. See lib/stationery/
 * catalog.ts.
 *
 * ── ONLY A SALES ORDER HAS ONE ────────────────────────────────────────────
 *
 * An invoice is raised when the goods are already going or gone; a quote has
 * nothing to deliver. A delivery note is what a sales order produces on its way
 * to becoming an invoice, and sales_order_details is where the delivery date and
 * the fulfilment status live.
 *
 * ── PRINTING ONE IS NOT COUNTED ───────────────────────────────────────────
 *
 * The print counter exists to answer "has this TAX INVOICE been on paper
 * before?", so a duplicate payment can be traced. A delivery note is expected to
 * be printed more than once — the driver loses it, the office wants a copy — and
 * counting those would dilute the number that matters.
 */
export default async function DeliveryNotePrintPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { capabilities } = await requireCapability('sales.view')
  const site = await requireSite()
  const { id: raw } = await params

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const doc = await getDocument(site.id, id)
  if (!doc) notFound()
  if (doc.docType !== 'sales_order') notFound()

  const [details, custom, logoHtml] = await Promise.all([
    getOrderDetails(site.id, id).catch(() => null),
    activeTemplate(site.id, 'delivery_note'),
    logoImgTag(site.id).catch(() => ''),
  ])

  /*
   * Where the goods GO, which is not always where the invoice is sent: a head
   * office pays and a site takes delivery. Falls back to the customer's own
   * address, because a delivery note with no address is a piece of paper the
   * driver cannot act on.
   */
  const shipTo = doc.customerId
    ? await defaultAddressFor(site.id, doc.customerId, 'delivery').catch(() => null)
    : null
  const deliverTo = shipTo
    ? [shipTo.line1, shipTo.line2, shipTo.city, shipTo.province, shipTo.postalCode]
        .map((x) => x?.trim())
        .filter((x): x is string => !!x)
    : []

  const printedAt = new Date().toLocaleString('en-ZA', {
    dateStyle: 'short',
    timeStyle: 'short',
  })

  const template = resolveTemplate('delivery_note', custom?.body ?? null, custom?.format)
  const input = deliveryNoteTokens({
    doc,
    details,
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
    deliverTo: deliverTo.length > 0 ? deliverTo : [doc.customerAddress ?? ''],
    printedAt,
    logoHtml,
  })

  const html = renderTemplate(template.body, 'delivery_note', { ...input, capabilities })

  return (
    <div className="px-6 py-6">
      <DocumentPrintButton doc={{ id: doc.id, docType: doc.docType }} />
      {/* Sanitised at save and re-validated at resolve; the values inside it are
          escaped by the renderer. See lib/stationery/sanitise.ts. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
