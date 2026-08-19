import { formatMoney } from '../../decimals'
import type { SalesDocument } from '../../site/salesDocuments'
import type { RenderInput, TokenValues } from '../render'

/**
 * An invoice, as the flat bag of token values the renderer reads.
 *
 * ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────────
 *
 * Cost and margin. `SalesLine` carries `unitCostExcl` on every line, and unlike
 * the purchase order this is not a permission question: what the shop paid is
 * nobody's business but the shop's, and there is no capability that should put
 * it on a document going to the person buying the goods. The catalog does not
 * name it and this does not supply it.
 *
 * Also absent: the internal note, the cancel reason, who the sales rep was, and
 * the terminal — records about the sale rather than the sale.
 *
 * ── THE HEADING IS A LEGAL FACT, NOT A LABEL ──────────────────────────────
 *
 * A VAT vendor's document must carry the words "tax invoice"; a business that
 * is not a vendor calling its document one is misrepresenting itself, and a
 * quote headed "tax invoice" is asking for money against an offer nobody has
 * accepted. So the heading is a VALUE, never something typed into a template:
 * the caller passes what the document is (the route already decides, from doc
 * type and status), and failing that the VAT-vendor rule applies.
 *
 * A template chooses where the heading goes. It cannot choose what it says.
 *
 * ── NO QUERIES ────────────────────────────────────────────────────────────
 *
 * Everything is already loaded by the print route. This maps; it does not fetch.
 */

export type InvoiceSources = {
  doc: SalesDocument
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
  /** Where the money should go. Omitted entirely when not fully configured. */
  banking?: {
    bank: string | null
    accountName: string | null
    accountNumber: string | null
    branchCode: string | null
  } | null
  printedAt: string
  logoHtml?: string | null
  /** A quote expires; empty on anything else. */
  validUntil?: string | null
  /** A sales order's promised date; empty on anything else. */
  deliveryDate?: string | null
  /** The customer's own order number, where they gave one. */
  customerOrderNo?: string | null
  /** Whether this document has been on paper before. */
  isReprint?: boolean
  /**
   * What the paper calls itself.
   *
   * Passed in rather than derived here, because the route already decides it:
   * one screen captures quotes, sales orders and invoices as one document at
   * different moments, and what it is CALLED follows from doc type and status
   * (see printKindFor in components/sales/SalesDocumentPrint.tsx). Deriving it
   * a second time here would be a second answer to the same question, and the
   * two would disagree the first time either changed.
   *
   * Omitted, this falls back to the VAT-vendor rule: a business with no VAT
   * number must not call its document a tax invoice.
   */
  heading?: string
  /** The line under the totals — what the reader is meant to do next. */
  closing?: string
}

const lines = (v: (string | null | undefined)[]) =>
  v.filter((l): l is string => !!l && l.trim() !== '').join('\n')

/**
 * VAT by rate, as the analysis a vendor is obliged to show.
 *
 * Derived from the lines rather than stored, because a document can carry more
 * than one rate (zero-rated food beside standard-rated goods) and the totals
 * columns only hold the sum. Rates with nothing on them are dropped: "VAT @ 0%
 * on R0.00" is a row that answers no question.
 */
function vatSummary(doc: SalesDocument): string {
  const byRate = new Map<number, { excl: number; vat: number }>()
  for (const l of doc.lines) {
    const at = byRate.get(l.vatRatePct) ?? { excl: 0, vat: 0 }
    at.excl += l.lineTotalExcl
    at.vat += l.lineVat
    byRate.set(l.vatRatePct, at)
  }
  return [...byRate.entries()]
    .filter(([, v]) => v.excl !== 0 || v.vat !== 0)
    .sort((a, b) => b[0] - a[0])
    .map(([rate, v]) => `VAT @ ${rate}% on ${formatMoney(v.excl)}: ${formatMoney(v.vat)}`)
    .join('\n')
}

/**
 * DRAFT, CANCELLED or REPRINT, in one token.
 *
 * The same shape the purchase order uses, and for the same reason: the template
 * language has no conditionals on purpose, so a condition that decides what
 * WORD prints belongs in the adapter rather than in a feature nobody else needs.
 *
 * REPRINT is only ever claimed for a finalised invoice. A quote is EXPECTED to
 * be printed repeatedly while it is negotiated, and stamping the second copy of
 * one as a reprint would say something about the document that is not true.
 */
function statusBanner(doc: SalesDocument, isReprint: boolean): string {
  if (doc.status === 'cancelled') return 'CANCELLED'
  if (doc.docType === 'invoice' && doc.status !== 'finalised') return 'PRO FORMA'
  if (isReprint && doc.docType === 'invoice' && doc.status === 'finalised') return 'REPRINT'
  return ''
}

export function invoiceTokens(src: InvoiceSources): RenderInput {
  const { doc, site } = src

  /*
   * All four banking fields or none. lib/invoices/build.ts puts the reason
   * plainly: "an invoice with a half-filled banking block is worse than one
   * with none, because it looks like enough information to pay against."
   */
  const b = src.banking
  const bankingComplete =
    !!b && !!b.bank && !!b.accountName && !!b.accountNumber && !!b.branchCode

  const values: TokenValues = {
    'site.name': site.name,
    'site.vatNumber': site.vatNumber,
    'site.registrationNumber': site.registrationNumber,
    'site.vatLine': site.vatNumber ? `VAT no. ${site.vatNumber}` : '',
    'site.registrationLine': site.registrationNumber
      ? `Reg. no. ${site.registrationNumber}`
      : '',
    'site.address': lines([site.address1, site.address2, site.address3, site.postalCode]),
    'site.address1': site.address1,
    'site.address2': site.address2,
    'site.address3': site.address3,
    'site.postalCode': site.postalCode,
    'site.phone': site.phone,
    'site.email': site.email,
    'site.logo': src.logoHtml ?? '',

    'doc.number': doc.documentNumber ?? `Draft #${doc.id}`,
    'doc.date': doc.documentDate,
    'doc.dueDate': doc.dueDate,
    'doc.reference': doc.reference,
    'doc.notes': doc.notes?.trim() ?? '',
    'doc.printedAt': src.printedAt,
    'doc.soldBy': doc.userName,
    'doc.validUntil': src.validUntil ?? '',
    'doc.deliveryDate': src.deliveryDate ?? '',
    /*
     * THEIR reference, not ours.
     *
     * The purchase-order number a customer will quote back, falling back to
     * whatever reference this document carries. One token because the reader
     * is asking one question — "what do I match this against?" — and a design
     * that had to choose between two would get it wrong for half the shops.
     */
    'doc.customerReference': src.customerOrderNo ?? doc.reference ?? '',
    'doc.statusBanner': statusBanner(doc, src.isReprint ?? false),
    // The route's own answer where it gave one; otherwise s20(4): only a VAT
    // vendor may call its document a tax invoice.
    'doc.heading': src.heading ?? (site.vatNumber ? 'TAX INVOICE' : 'INVOICE'),
    'doc.closing': src.closing ?? '',

    'customer.name': doc.customerName ?? 'Cash sale',
    'customer.code': doc.customerCode ?? '',
    'customer.address': doc.customerAddress ?? '',
    'customer.phone': doc.customerPhone ?? '',
    'customer.vatNumber': doc.customerVatNo ?? '',

    'banking': bankingComplete
      ? lines([b!.bank, b!.accountName, `Acc. ${b!.accountNumber}`, `Branch ${b!.branchCode}`])
      : '',

    'totals.goodsExcl': doc.subtotalExcl,
    'totals.discountIncl': doc.discountTotal > 0 ? doc.discountTotal : null,
    'totals.vat': doc.vatTotal,
    'totals.roundingAdj': doc.roundingAdj !== 0 ? doc.roundingAdj : null,
    'totals.totalIncl': doc.totalIncl,
    'totals.vatSummary': vatSummary(doc),
  }

  const rows: TokenValues[] = doc.lines.map((line) => ({
    'line.number': String(line.lineNumber),
    'line.description': line.description,
    'line.productCode': line.productCode ?? '',
    'line.qty': line.qty,
    'line.unitPriceIncl': line.unitPriceIncl,
    'line.discountPct': line.discountPct > 0 ? line.discountPct : null,
    'line.vatRatePct': line.vatRatePct,
    'line.totalExcl': line.lineTotalExcl,
    'line.totalIncl': line.lineTotalIncl,
  }))

  return { values, sections: { lines: rows }, capabilities: { isOwner: false, granted: new Set() } }
}
