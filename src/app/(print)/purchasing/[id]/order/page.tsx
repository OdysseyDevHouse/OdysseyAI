import './order-a4.css'
import { pictureIds } from '@/lib/site/stationeryImages'
import { notFound } from 'next/navigation'
import { requireCapability, requireSite, requireActor } from '@/lib/auth'
import { getPurchaseDocument, purchaseAudit, recordOrderPrint } from '@/lib/site/purchaseDocuments'
import { getSupplier } from '@/lib/site/suppliers'
import { activeTemplate } from '@/lib/site/stationeryTemplates'
import { logoImgTag } from '@/lib/site/documentLogo'
import { purchaseOrderTokens } from '@/lib/stationery/adapters/purchaseOrder'
import { renderTemplate } from '@/lib/stationery/render'
import { resolveTemplate } from '@/lib/stationery/resolve'
import OrderPrintButton from './OrderPrintButton'

export const dynamic = 'force-dynamic'

/**
 * The printable purchase order — the supplier's copy.
 *
 * Its own route in the bare (print) group rather than a modal, so the browser
 * prints the document and not the application around it — the same reason the
 * lay-by agreement and the statement have one. This segment's CSS overrides
 * the group's 80mm @page with A4.
 *
 * ORDERS ONLY. A GRV is our record of what arrived and a supplier return has
 * its own instrument; neither is a thing you send someone asking them to
 * supply goods, so both 404 rather than printing under a heading that lies.
 */
export default async function PurchaseOrderPrintPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('purchasing.view')
  const site = await requireSite()
  const { id: raw } = await params

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const doc = await getPurchaseDocument(siteId, id)
  if (!doc || doc.docType !== 'purchase_order') notFound()

  const [supplier, trail, custom, logoHtml] = await Promise.all([
    getSupplier(siteId, doc.supplierId),
    purchaseAudit(siteId, id),
    // Never throws: a site with no designed stationery, or without the table
    // yet, gets null and prints the shipped default.
    activeTemplate(siteId, 'purchase_order'),
    logoImgTag(siteId),
  ])

  /*
   * Whether this is a reprint, decided BEFORE we log this one.
   *
   * The question the paper answers is "has this order been on paper before?",
   * so an order printed for the first time must not call itself a reprint on
   * the strength of the row it is about to write.
   */
  const isReprint = trail.some((e) => e.action === 'printed' || e.action === 'reprinted')

  /*
   * Rendering the page IS the print. There is no way to know whether the
   * browser dialog was confirmed, so the honest thing to record is that the
   * document was pulled up for printing — which is the fact anyone querying a
   * duplicate delivery actually needs. Drafts are excluded: pulling one up to
   * see how it will look is not a copy that left the building.
   *
   * Never allowed to break the page: an order that cannot be printed because
   * the audit table is missing would be a worse failure than a missing line in
   * a history panel.
   */
  if (doc.status !== 'draft') {
    const { actor } = await requireActor()
    await recordOrderPrint(siteId, actor, doc, isReprint).catch(() => {})
  }

  const printedAt = new Date().toLocaleString('en-ZA', {
    dateStyle: 'short',
    timeStyle: 'short',
  })

  // Where the goods must go. The ordering store's own address — a supplier
  // needs a street, not a site name.
  const deliverTo = [
    site.displayName,
    site.address1,
    site.address2,
    site.address3,
    site.postalCode,
  ].filter((l): l is string => !!l && l.trim() !== '')

  /*
   * The document is composed from a TEMPLATE rather than a component, so a site
   * can change what its suppliers see without a deployment. This resolves to
   * the shipped default when the site has designed nothing, and to the site's
   * own template when it has (Setup → Stationery). A template that no longer
   * validates is skipped by resolveTemplate rather than printed — a wrong
   * document is worse than a plain one.
   *
   * Capabilities are passed through rather than baked in: the cost columns
   * print for whoever holds products.cost and are silently blank for everyone
   * else, so one template serves the buyer and the counter alike.
   */
  const template = resolveTemplate('purchase_order', custom?.body ?? null, custom?.format)
  const input = purchaseOrderTokens({
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
    supplier,
    deliverTo,
    printedAt,
    isReprint,
    logoHtml,
  })

  const html = renderTemplate(template.body, 'purchase_order', {
    ...input,
    capabilities,
    pictures: await pictureIds(site.id),
  })

  return (
    <div className="px-6 py-6">
      <OrderPrintButton documentId={doc.id} />
      {/* Sanitised at save and re-validated at resolve; the values inside it are
          escaped by the renderer. See lib/stationery/sanitise.ts. */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
