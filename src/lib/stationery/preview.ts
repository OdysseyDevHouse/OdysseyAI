import 'server-only'
import { getPurchaseDocument, listPurchaseDocuments } from '../site/purchaseDocuments'
import { getSupplier } from '../site/suppliers'
import { purchaseOrderTokens } from './adapters/purchaseOrder'
import { invoiceTokens, type InvoiceSources } from './adapters/invoice'
import { logoImgTag } from '../site/documentLogo'
import type { RenderInput } from './render'
import type { PurchaseDocument } from '../site/purchaseDocuments'
import type { SalesDocument } from '../site/salesDocuments'
import type { ReceiptData } from '../receiptData'

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
 * A sale to preview a slip design against.
 *
 * Invented rather than a real one, unlike the purchase order. A slip is a
 * receipt for a sale that happened minutes ago at a till, and putting a real
 * customer's name and what they bought on a setup screen — where it can be
 * left open on a back-office monitor — is a use of that record nobody
 * consented to. The order a shop places with its supplier carries no such
 * problem.
 *
 * Deliberately awkward all the same: a fractional quantity, a line with a note
 * that must wrap, a discount, cash rounding and two tenders, because those are
 * the things a design breaks on.
 */
export function sampleReceipt(siteName: string, vatNumber: string | null): ReceiptData {
  return {
    proForma: false,
    gift: false,
    siteName,
    vatNumber,
    documentNumber: 'INV000481',
    documentDate: new Date().toISOString().slice(0, 10),
    printedAt: new Date().toLocaleTimeString('en-ZA', { timeStyle: 'short' }),
    cashierName: 'Sam',
    terminalCode: 'TILL 1',
    customerName: 'A. Customer',
    customerVatNo: null,
    lines: [
      { qty: 2, description: 'Bread, white', unitPriceIncl: 21.99, lineTotalIncl: 43.98, notes: [] },
      {
        qty: 1.42,
        description: 'Cheese, mature cheddar',
        unitPriceIncl: 189.9,
        lineTotalIncl: 269.66,
        notes: ['sliced thin'],
      },
      { qty: 1, description: 'Milk 2L', unitPriceIncl: 34.99, lineTotalIncl: 34.99, notes: [] },
    ],
    subtotalExcl: 304.9,
    vatTotal: 45.73,
    discountTotal: 15,
    totalIncl: 335.6,
    roundingAdj: -0.03,
    vatByRate: [{ ratePct: 15, excl: 304.9, vat: 45.73, incl: 350.63 }],
    tenders: [
      { name: 'Cash', amount: 300, changeGiven: 0, reference: null },
      { name: 'Card', amount: 35.6, changeGiven: 0, reference: '****4242' },
    ],
    changeGiven: 0,
    loyalty: { pointsEarned: 33, balance: 415 },
    copyNumber: 0,
    footerText: '',
  } as unknown as ReceiptData
}

/**
 * An invoice to preview a design against.
 *
 * Invented, like the slip and unlike the purchase order — and for the same
 * reason. An invoice names a customer and lists what they bought; putting a
 * real one on a setup screen that can sit open on a back-office monitor is a
 * use of that record nobody agreed to. A purchase order names a supplier and
 * carries no such problem.
 *
 * Two VAT rates on purpose: a shop selling zero-rated food beside standard-rated
 * goods is the case where a single summed VAT figure is not a lawful analysis,
 * and a designer should see both lines while laying the document out.
 */
export async function invoicePreview(
  siteId: number,
  site: InvoiceSources['site'],
): Promise<PreviewSource> {
  const doc = {
    id: 0,
    docType: 'invoice',
    status: 'finalised',
    documentNumber: 'INV000481',
    documentDate: new Date().toISOString().slice(0, 10),
    dueDate: null,
    customerId: 1,
    customerCode: 'ACC001',
    customerName: 'A. Customer',
    customerVatNo: '4987654321',
    customerPhone: '021 555 0300',
    customerAddress: '9 Long Street\nCape Town\n8001',
    userName: 'Sam',
    subtotalExcl: 304.9,
    vatTotal: 45.73,
    discountTotal: 15,
    totalIncl: 350.63,
    roundingAdj: 0,
    reference: null,
    notes: 'Please quote the invoice number with your payment.',
    lines: [
      {
        id: 1, lineNumber: 1, productCode: 'BRD-WHT', description: 'Bread, white',
        qty: 2, unitPriceIncl: 21.99, discountPct: 0, vatRatePct: 0,
        lineTotalIncl: 43.98, lineTotalExcl: 43.98, lineVat: 0, unitCostExcl: 14,
      },
      {
        id: 2, lineNumber: 2, productCode: 'CHS-MAT',
        description: 'Cheese, mature cheddar, vacuum packed 500g',
        qty: 1.42, unitPriceIncl: 189.9, discountPct: 10, vatRatePct: 15,
        lineTotalIncl: 269.66, lineTotalExcl: 234.49, lineVat: 35.17, unitCostExcl: 120,
      },
      {
        id: 3, lineNumber: 3, productCode: 'MLK-2L', description: 'Milk 2L',
        qty: 1, unitPriceIncl: 34.99, discountPct: 0, vatRatePct: 15,
        lineTotalIncl: 34.99, lineTotalExcl: 30.43, lineVat: 4.56, unitCostExcl: 22,
      },
    ],
  } as unknown as SalesDocument

  const logoHtml = await logoImgTag(siteId)

  return {
    input: invoiceTokens({
      doc,
      site,
      // Shown complete, so a designer can position the block. A shop with no
      // bank account on file prints nothing there — see the adapter.
      banking: {
        bank: 'Your Bank',
        accountName: site.name,
        accountNumber: '62000000000',
        branchCode: '250655',
      },
      printedAt: new Date().toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' }),
      logoHtml,
    }),
    label: 'A sample invoice, with two VAT rates.',
  }
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
  // The real logo, so a designer positioning {site.logo} is moving the actual
  // picture rather than a placeholder that will turn out to be a different size.
  const logoHtml = await logoImgTag(siteId)

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
          input: purchaseOrderTokens({ doc, site, supplier, deliverTo, printedAt, isReprint: false, logoHtml }),
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
      logoHtml,
    }),
    label: 'Sample data — this shop has no purchase orders yet.',
  }
}
