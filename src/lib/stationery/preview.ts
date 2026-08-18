import 'server-only'
import { getPurchaseDocument, listPurchaseDocuments } from '../site/purchaseDocuments'
import { getSupplier } from '../site/suppliers'
import { purchaseOrderTokens } from './adapters/purchaseOrder'
import type { RenderInput } from './render'
import type { PurchaseDocument } from '../site/purchaseDocuments'

/**
 * What a designed document is previewed AGAINST.
 *
 * ── A REAL DOCUMENT WHERE THERE IS ONE ────────────────────────────────────
 *
 * The preview reaches for this site's most recent purchase order before it
 * reaches for invented data, because the interesting failures only show up on
 * real records: a supplier with no address, a fifteen-word product description
 * that wraps, forty lines that run onto a second page. A designer who lays out
 * a document against "Widget × 3" discovers all of that at the supplier's end.
 *
 * ── SAMPLE DATA IS THE FALLBACK, NOT THE DEFAULT ──────────────────────────
 *
 * A brand-new shop has no orders and still has to be able to design its
 * stationery, so there is invented data — but it is deliberately awkward
 * (a long description, a line with no supplier code, an order with no
 * reference) rather than tidy, for the same reason.
 *
 * ── IT NEVER THROWS ───────────────────────────────────────────────────────
 *
 * A preview that 500s because one old order has a null supplier would make the
 * designer unusable for the shop that most needs it. Every failure falls back
 * to the sample.
 */

export type PreviewSource = {
  input: RenderInput
  /** What the preview is showing, for a line under the pane. */
  label: string
}

const SAMPLE_SITE = {
  name: 'Your Business',
  vatNumber: '4123456789',
  registrationNumber: '2019/123456/07',
  address1: 'Unit 4, Fairview Office Park',
  address2: 'Central',
  address3: 'George',
  postalCode: '6529',
  phone: '044 555 0100',
  email: 'buying@yourbusiness.co.za',
}

const SAMPLE_SUPPLIER = {
  name: 'Sample Supply Co',
  contactName: 'A. Buyer',
  email: 'sales@samplesupply.co.za',
  phone: '021 555 0200',
  addressLine1: '12 Warehouse Road',
  addressLine2: null,
  city: 'Cape Town',
  postalCode: '7441',
  vatNumber: '4987654321',
  accountNumber: 'YB-0001',
  paymentTermsDays: 30,
}

/**
 * An order that exercises the awkward cases on purpose.
 *
 * A long description that must wrap, a line with no supplier code so the
 * fallback shows, a discounted line, and a fractional quantity — every one of
 * which has broken a real layout that looked fine against tidy data.
 */
function sampleDocument(): PurchaseDocument {
  return {
    id: 0,
    docType: 'purchase_order',
    docLabel: 'Purchase order',
    status: 'issued',
    documentNumber: 'PO000123',
    documentDate: new Date().toISOString().slice(0, 10),
    dueDate: null,
    supplierId: 0,
    supplierCode: 'SAMPLE',
    supplierName: SAMPLE_SUPPLIER.name,
    supplierInvoiceNo: null,
    userName: 'A. Buyer',
    subtotalExcl: 1362.5,
    vatTotal: 204.38,
    totalIncl: 1566.88,
    chargesExcl: 0,
    discountExcl: 0,
    discountPct: 0,
    orderedFromId: null,
    reference: null,
    notes: 'Deliver to the goods entrance before 11:00.',
    cancelReason: null,
    finalisedAt: null,
    createdAt: new Date(),
    fulfilmentStatus: null,
    expectedDate: null,
    supplierOrderNo: null,
    lines: [
      {
        id: 1, documentId: 0, lineNumber: 1, productId: 1,
        productCode: 'GALV-16-6M', supplierCode: 'SS-GALV166',
        description: 'Galvanised steel tubing, 16mm outside diameter, 6 metre length',
        productType: 'stock', departmentId: null,
        qtyOrdered: 24, qtyReceived: 0, qtyBonus: 0, qtyArrived: 0, qtyOutstanding: 24,
        unitCostExcl: 42.5, discountPct: 0, discountAmount: 0, vatRatePct: 15,
        lineTotalExcl: 1020, lineVat: 153, lineTotalIncl: 1173,
        chargeExcl: 0, landedCostExcl: 1020,
        locationId: null, sourceLineId: null, jobCardLineId: null,
      },
      {
        id: 2, documentId: 0, lineNumber: 2, productId: 2,
        productCode: 'SEAL-9', supplierCode: null,
        description: 'Rubber seal 9mm',
        productType: 'stock', departmentId: null,
        qtyOrdered: 100, qtyReceived: 0, qtyBonus: 0, qtyArrived: 0, qtyOutstanding: 100,
        unitCostExcl: 2.75, discountPct: 10, discountAmount: 0, vatRatePct: 15,
        lineTotalExcl: 247.5, lineVat: 37.13, lineTotalIncl: 284.63,
        chargeExcl: 0, landedCostExcl: 247.5,
        locationId: null, sourceLineId: null, jobCardLineId: null,
      },
      {
        id: 3, documentId: 0, lineNumber: 3, productId: 3,
        productCode: 'SAND-BULK', supplierCode: 'SS-SAND',
        description: 'Builders sand',
        productType: 'stock', departmentId: null,
        qtyOrdered: 2.5, qtyReceived: 0, qtyBonus: 0, qtyArrived: 0, qtyOutstanding: 2.5,
        unitCostExcl: 38, discountPct: 0, discountAmount: 0, vatRatePct: 15,
        lineTotalExcl: 95, lineVat: 14.25, lineTotalIncl: 109.25,
        chargeExcl: 0, landedCostExcl: 95,
        locationId: null, sourceLineId: null, jobCardLineId: null,
      },
    ],
  } as unknown as PurchaseDocument
}

/**
 * Token values for previewing a purchase order.
 *
 * The site's own letterhead is used even for the sample, so a designer is
 * always looking at their own business name rather than "Your Business".
 */
export async function purchaseOrderPreview(
  siteId: number,
  site: {
    name: string
    vatNumber: string | null
    registrationNumber: string | null
    address1: string | null
    address2: string | null
    address3: string | null
    postalCode: string | null
    phone: string | null
    email: string | null
  },
): Promise<PreviewSource> {
  const printedAt = new Date().toLocaleString('en-ZA', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
  const deliverTo = [site.name, site.address1, site.address2, site.address3, site.postalCode].filter(
    (l): l is string => !!l && l.trim() !== '',
  )

  try {
    const recent = await listPurchaseDocuments(siteId, {
      docTypes: ['purchase_order'],
      limit: 1,
    })
    const head = recent.items[0]
    if (head) {
      const doc = await getPurchaseDocument(siteId, head.id)
      if (doc && doc.lines.length > 0) {
        const supplier = await getSupplier(siteId, doc.supplierId).catch(() => null)
        return {
          input: purchaseOrderTokens({ doc, site, supplier, deliverTo, printedAt, isReprint: false }),
          label: `Previewing ${doc.documentNumber ?? `draft #${doc.id}`} — one of your real orders.`,
        }
      }
    }
  } catch {
    /* fall through to the sample */
  }

  // Invented lines, but the shop's OWN letterhead — a designer should never be
  // laying out a document that says "Your Business" where their name will go.
  return {
    input: purchaseOrderTokens({
      doc: sampleDocument(),
      site,
      supplier: SAMPLE_SUPPLIER,
      deliverTo,
      printedAt,
      isReprint: false,
    }),
    label: 'Sample data — this shop has no purchase orders yet.',
  }
}
