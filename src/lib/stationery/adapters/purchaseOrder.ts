import type { PurchaseDocument } from '../../site/purchaseDocuments'
import type { RenderInput, TokenValues } from '../render'

/**
 * A purchase order, as the flat bag of token values the renderer reads.
 *
 * ── WHY AN ADAPTER AND NOT THE MODEL ITSELF ───────────────────────────────
 *
 * The renderer is handed `Record<string, unknown>` keyed by catalog token, and
 * this is the only place a `PurchaseDocument` is turned into one. That is the
 * point: `PurchaseDocument` carries qtyReceived, landedCostExcl and
 * qtyOutstanding, none of which belong on the supplier's copy. Passing the
 * model straight through would make every one of them one typo away from the
 * page. Here, a field reaches paper only because a line in this file put it
 * there.
 *
 * The catalog refuses to name them and this refuses to supply them — two
 * independent locks, because the cost of a supplier reading our receiving
 * records is high and the cost of a second lock is one file.
 *
 * ── NO QUERIES ────────────────────────────────────────────────────────────
 *
 * Everything here is already loaded by the print route through the existing
 * helpers (getPurchaseDocument, getSupplier, requireSite). This maps; it does
 * not fetch.
 */

export type PurchaseOrderSources = {
  doc: PurchaseDocument
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
  }
  supplier: {
    name: string
    contactName: string | null
    email: string | null
    phone: string | null
    addressLine1: string | null
    addressLine2: string | null
    city: string | null
    postalCode: string | null
    vatNumber: string | null
    accountNumber: string | null
    paymentTermsDays: number
  } | null
  /** Where the goods must physically go — the ordering store's own address. */
  deliverTo: string[]
  printedAt: string
  isReprint: boolean
  /**
   * The site's logo as a ready-made `<img>` tag, from
   * lib/site/documentLogo.ts, or empty when there is none.
   *
   * A tag rather than a URL: the token then carries its own sizing, so a
   * letterhead cannot be broken by a 3000px original, and there is no way for a
   * template to point the `src` somewhere else.
   */
  logoHtml?: string | null
}

const lines = (v: (string | null | undefined)[]) =>
  v.filter((l): l is string => !!l && l.trim() !== '').join('\n')

/**
 * The one-line status the paper needs, decided here rather than in the template.
 *
 * A draft has no number a supplier could quote back, so the paper has to say
 * so; a cancelled order must not read as live; and two copies of an order in a
 * supplier's inbox is how an order gets filled twice, so a reprint says which
 * one it is. All three are conditions, and the template language has no
 * conditionals on purpose — so the CONDITION lives in TypeScript, where it is
 * tested, and the template only chooses where to put the answer.
 */
function statusBanner(doc: PurchaseDocument, isReprint: boolean): string {
  if (doc.status === 'draft') return 'DRAFT — NOT YET ISSUED'
  if (doc.status === 'cancelled') return 'CANCELLED'
  if (isReprint) return 'REPRINT'
  return ''
}

export function purchaseOrderTokens(src: PurchaseOrderSources): RenderInput {
  const { doc, site, supplier } = src

  const values: TokenValues = {
    'site.name': site.name,
    'site.vatNumber': site.vatNumber,
    'site.registrationNumber': site.registrationNumber,
    'site.address': lines([site.address1, site.address2, site.address3, site.postalCode]),
    'site.address1': site.address1,
    'site.address2': site.address2,
    'site.address3': site.address3,
    'site.postalCode': site.postalCode,
    // Label and value together, so a business that is not a VAT vendor gets no
    // orphaned "VAT no." caption over a blank.
    'site.vatLine': site.vatNumber ? `VAT no. ${site.vatNumber}` : '',
    'site.registrationLine': site.registrationNumber
      ? `Reg. no. ${site.registrationNumber}`
      : '',
    'site.phone': site.phone,
    'site.email': site.email,
    // Composed by lib/site/documentLogo.ts, or blank — which keeps the header
    // tidy rather than leaving a broken image on a document going to a supplier.
    'site.logo': src.logoHtml ?? '',

    // A draft has no number, so the paper says which draft it is rather than
    // printing an empty box a supplier might mistake for a real order.
    'doc.number': doc.documentNumber ?? `Draft #${doc.id}`,
    'doc.date': doc.documentDate,
    'doc.reference': doc.reference,
    'doc.notes': doc.notes?.trim() ?? '',
    'doc.printedAt': src.printedAt,
    'doc.expectedDate': doc.expectedDate,
    'doc.orderedBy': doc.userName,
    'doc.status': doc.status,
    'doc.statusBanner': statusBanner(doc, src.isReprint),

    'supplier.name': supplier?.name ?? doc.supplierName ?? '',
    'supplier.contactName': supplier?.contactName ?? '',
    'supplier.address': lines([
      supplier?.addressLine1,
      supplier?.addressLine2,
      [supplier?.city, supplier?.postalCode].filter(Boolean).join(' ').trim() || null,
    ]),
    'supplier.email': supplier?.email ?? '',
    'supplier.phone': supplier?.phone ?? '',
    'supplier.vatNumber': supplier?.vatNumber ?? '',
    'supplier.accountNumber': supplier?.accountNumber ?? '',
    'supplier.paymentTerms':
      supplier && supplier.paymentTermsDays > 0 ? String(supplier.paymentTermsDays) : '',
    // Label and value together, so an absent one leaves no orphaned caption.
    'supplier.accountLine': supplier?.accountNumber
      ? `Our account: ${supplier.accountNumber}`
      : '',
    'supplier.paymentTermsLine':
      supplier && supplier.paymentTermsDays > 0 ? `${supplier.paymentTermsDays} days` : '',

    'deliverTo': src.deliverTo.join('\n'),

    'totals.goodsExcl': doc.subtotalExcl,
    'totals.chargesExcl': doc.chargesExcl > 0 ? doc.chargesExcl : null,
    'totals.discountExcl': doc.discountExcl > 0 ? doc.discountExcl : null,
    'totals.vat': doc.vatTotal,
    'totals.totalIncl': doc.totalIncl,
  }

  /*
   * Quantity is what was ORDERED, always. On a part-received order a reprint
   * still says ten, because the order was for ten — the outstanding position is
   * a receiving question and belongs on the receiving screen.
   */
  const rows: TokenValues[] = doc.lines.map((line) => ({
    'line.number': String(line.lineNumber),
    'line.description': line.description,
    'line.productCode': line.productCode ?? '',
    // Their code first when we know it: the supplier picks from their own
    // catalogue, not ours.
    'line.supplierCode': line.supplierCode ?? line.productCode ?? '',
    'line.qty': line.qtyOrdered,
    'line.unitCostExcl': line.unitCostExcl,
    'line.discountPct': line.discountPct > 0 ? line.discountPct : null,
    'line.discountAmount': line.discountAmount > 0 ? line.discountAmount : null,
    'line.vatRatePct': line.vatRatePct,
    'line.totalExcl': line.lineTotalExcl,
  }))

  return { values, sections: { lines: rows }, capabilities: { isOwner: false, granted: new Set() } }
}
