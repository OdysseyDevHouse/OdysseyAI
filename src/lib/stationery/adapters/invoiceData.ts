import { formatMoney } from '../../decimals'
import type { RenderInput, TokenValues } from '../render'
import type { InvoiceData } from '../../invoices/pdf'

/**
 * An emailed invoice's data, as the same tokens the printed one resolves.
 *
 * ── WHY A SECOND ADAPTER AND NOT A SECOND TEMPLATE ────────────────────────
 *
 * The printed invoice is built from a SalesDocument; the emailed one from
 * InvoiceData, which lib/invoices/build.ts assembles for the PDF and the
 * customer portal. Two shapes carrying nearly the same facts.
 *
 * The alternative was to convert one into the other, and it is worse: they are
 * not quite the same document. An emailed invoice carries a pay-online link and
 * a foot note naming the contract it came from, neither of which exists on a
 * SalesDocument; a printed one knows whether it is a reprint, which an email
 * cannot be. Forcing either through the other's type means inventing fields.
 *
 * So both adapt to the TOKENS, which is the thing they genuinely share — and
 * one design then drives print and email, because a design names tokens and
 * knows nothing about where they came from.
 *
 * ── WHAT DIFFERS, AND WHY THAT IS FINE ────────────────────────────────────
 *
 * Tokens with no source here resolve to '' rather than being absent, and every
 * block that shows one drops itself when it is empty. So a design carrying the
 * pay-online link prints nothing on paper and a live link in an email, with no
 * conditional anywhere.
 */

const lines = (parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join('\n')

/**
 * VAT by rate, from lines that carry only an INCLUSIVE total.
 *
 * The printed adapter reads lineTotalExcl and lineVat straight off the document;
 * InvoiceLine has neither, so the split is derived from the rate. Same arithmetic
 * the totals already used to reach the same numbers, and it agrees with them for
 * the reason it must: both work from the same inclusive line total.
 */
function vatSummary(data: InvoiceData, taxLabel: string): string {
  const byRate = new Map<number, { excl: number; vat: number }>()
  for (const l of data.lines) {
    const rate = l.vatRatePct
    const excl = rate === 0 ? l.lineTotalIncl : l.lineTotalIncl / (1 + rate / 100)
    const at = byRate.get(rate) ?? { excl: 0, vat: 0 }
    at.excl += excl
    at.vat += l.lineTotalIncl - excl
    byRate.set(rate, at)
  }
  return [...byRate.entries()]
    .filter(([, v]) => v.excl !== 0 || v.vat !== 0)
    .sort((a, b) => b[0] - a[0])
    .map(([rate, v]) => `${taxLabel} @ ${rate}% on ${formatMoney(v.excl)}: ${formatMoney(v.vat)}`)
    .join('\n')
}

export function invoiceDataTokens(
  data: InvoiceData,
  extra: {
    /** The `<img>` for {site.logo}. The emailed PDF had no logo at all before. */
    logoHtml?: string | null
    /** TAX INVOICE or INVOICE. Falls back to the VAT-vendor rule. */
    heading?: string
    closing?: string
    printedAt?: string
    /** What this business calls its tax. Absent falls back to VAT. */
    taxLabel?: string
  } = {},
): RenderInput {
  const { site, customer } = data

  /* Resolved once: it appears in the letterhead line and in the rate analysis,
     and those two must never disagree about what the tax is called. */
  const taxLabel = extra.taxLabel ?? 'VAT'

  /*
   * All four banking fields or none — the rule build.ts states plainly: "an
   * invoice with a half-filled banking block is worse than one with none,
   * because it looks like enough information to pay against."
   */
  const b = data.banking
  const bankingComplete =
    !!b && !!b.bank && !!b.accountName && !!b.accountNumber && !!b.branchCode

  const values: TokenValues = {
    'site.name': site.name,
    'site.vatNumber': site.vatNumber,
    'site.registrationNumber': site.registrationNumber ?? null,
    'site.vatLine': site.vatNumber ? `${taxLabel} no. ${site.vatNumber}` : '',
    'site.registrationLine': site.registrationNumber
      ? `Reg. no. ${site.registrationNumber}`
      : '',
    'site.address': (site.addressLines ?? []).filter(Boolean).join('\n'),
    'site.address1': site.addressLines?.[0] ?? '',
    'site.address2': site.addressLines?.[1] ?? '',
    'site.address3': site.addressLines?.[2] ?? '',
    'site.postalCode': site.addressLines?.[3] ?? '',
    'site.phone': site.phone ?? '',
    'site.email': site.email ?? '',
    'site.logo': extra.logoHtml ?? '',

    'doc.number': data.documentNumber ?? 'Not yet issued',
    'doc.date': data.documentDate,
    'doc.dueDate': data.dueDate,
    'doc.reference': data.reference,
    'doc.notes': data.notes?.trim() ?? '',
    'doc.printedAt': extra.printedAt ?? '',
    // An emailed invoice has no clerk on it: it was not served over a counter.
    'doc.soldBy': '',
    'doc.heading': extra.heading ?? (site.vatNumber ? 'TAX INVOICE' : 'INVOICE'),
    'doc.closing': extra.closing ?? '',

    /*
     * The kind-specific dates are printed-page concepts. An email is always a
     * finalised invoice and never a quote, so these are empty and the rows
     * carrying them drop themselves.
     */
    'doc.validUntil': '',
    'doc.deliveryDate': '',
    'doc.customerReference': data.reference ?? '',
    /*
     * PAID says something the emailed copy could not before.
     *
     * The banner was hardcoded empty here on the reasoning that an email is
     * never a reprint and never a pro forma — true, and it missed the one
     * status an emailed invoice genuinely can carry. A customer who pays a link
     * and then opens the attachment they were sent should not be looking at a
     * document that still reads as a demand.
     *
     * Only when the caller has actually established it — see `paidInFull` on
     * InvoiceData for why silence is the right default.
     */
    'doc.statusBanner': data.paidInFull ? 'PAID' : '',

    // The two an email has and paper does not.
    'doc.paymentUrl': data.paymentUrl ?? '',
    'doc.footNote': data.footNote ?? '',

    'customer.name': customer.name,
    'customer.code': customer.code ?? '',
    'customer.address': customer.addressLines.filter(Boolean).join('\n'),
    'customer.phone': customer.phone ?? '',
    'customer.vatNumber': customer.vatNumber ?? '',

    banking: bankingComplete
      ? lines([b!.bank, b!.accountName, `Acc. ${b!.accountNumber}`, `Branch ${b!.branchCode}`])
      : '',

    'totals.goodsExcl': data.subtotalExcl,
    'totals.discountIncl': data.discountTotal > 0 ? data.discountTotal : null,
    'totals.vat': data.vatTotal,
    // InvoiceData carries no rounding adjustment; the row drops itself.
    'totals.roundingAdj': null,
    'totals.totalIncl': data.totalIncl,
    'totals.vatSummary': vatSummary(data, taxLabel),
  }

  const rows: TokenValues[] = data.lines.map((line, i) => ({
    'line.number': String(i + 1),
    'line.description': line.description,
    'line.productCode': line.productCode ?? '',
    'line.qty': line.qty,
    'line.unitPriceIncl': line.unitPriceIncl,
    'line.discountPct': line.discountPct > 0 ? line.discountPct : null,
    'line.vatRatePct': line.vatRatePct,
    // Derived, as the VAT summary is: an emailed line carries only its
    // inclusive total.
    'line.totalExcl':
      line.vatRatePct === 0
        ? line.lineTotalIncl
        : line.lineTotalIncl / (1 + line.vatRatePct / 100),
    'line.totalIncl': line.lineTotalIncl,
  }))

  return {
    values,
    sections: { lines: rows },
    capabilities: { isOwner: false, granted: new Set() },
    taxLabel,
  }
}
