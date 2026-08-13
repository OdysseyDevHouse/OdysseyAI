import { documentTotals, lineTotals } from './documentMath'
import type { SalesDocument } from './site/salesDocuments'

/**
 * The slice of an instruction answer a slip needs. Structural on purpose: the
 * server's SalesLineInstruction and the till's ChosenOption both satisfy it,
 * and this file must serve both without importing either world.
 */
export type SlipInstruction = {
  optionName: string
  qty: number
  printsOnReceipt: boolean
}

/**
 * A till slip, as data.
 *
 * Pure and layout-free, exactly like billData.ts and for the same reason: the
 * browser print route renders this AND the ESC/POS renderer consumes the SAME
 * object — one builder, two printers, and a slip that cannot disagree with
 * itself between them.
 *
 * TWO constructors. `receiptDataFor` reads a FINALISED document — the stored
 * money figures are canonical for a posted sale, so total/rounding/change come
 * from the document and only the VAT split is recomputed. `receiptDataFromBasket`
 * builds the OFFLINE slip from what the till holds at finalise: basket lines,
 * the local number, the pad's own change plan. No server, no loyalty footer.
 *
 * A receipt without a number is not a tax invoice — `receiptDataFor` throws on
 * a null document number, the mirror of billData's "no number is load-bearing".
 */

export type ReceiptLine = {
  description: string
  qty: number
  unitPriceIncl: number
  lineTotalIncl: number
  /** Instruction answers marked prints_on_receipt, plus the free-text note. */
  notes: string[]
}

export type ReceiptTender = {
  name: string
  amount: number
  changeGiven: number
  reference: string | null
}

export type ReceiptData = {
  proForma: false
  /** Prices suppressed by the RENDERERS — the data keeps them so one object serves both prints. */
  gift: boolean
  siteName: string
  vatNumber: string | null
  documentNumber: string
  documentDate: string
  printedAt: string
  cashierName: string
  terminalCode: string | null
  customerName: string | null
  customerVatNo: string | null
  lines: ReceiptLine[]
  subtotalExcl: number
  vatTotal: number
  discountTotal: number
  totalIncl: number
  roundingAdj: number
  vatByRate: { ratePct: number; excl: number; vat: number; incl: number }[]
  tenders: ReceiptTender[]
  changeGiven: number
  loyalty: { pointsEarned: number; balance: number } | null
  /** 0 = the original; above zero the slip says COPY. Driven by print_count. */
  copyNumber: number
  footerText: string
}

/** The slip's per-line notes: kitchen answers stay off, receipt answers on. */
export function receiptNotes(
  instructions: readonly SlipInstruction[] | undefined,
  freeNote?: string | null,
): string[] {
  const notes = (instructions ?? [])
    .filter((i) => i.printsOnReceipt)
    .map((i) => (i.qty > 1 ? `${i.qty} × ${i.optionName}` : i.optionName))
  if (freeNote?.trim()) notes.push(freeNote.trim())
  return notes
}

export function receiptDataFor(
  doc: SalesDocument,
  site: { name: string; vatNumber: string | null },
  tenders: ReceiptTender[],
  opts: {
    printedAt: string
    gift?: boolean
    loyalty?: { pointsEarned: number; balance: number } | null
    copyNumber?: number
    footerText?: string
  },
): ReceiptData {
  if (!doc.documentNumber) {
    throw new Error('A slip needs a document number — an unnumbered sale is not a tax invoice.')
  }

  // The VAT split is recomputed through the same engine the sale posted with;
  // the headline money is the STORED document — canonical for a posted sale.
  const computed = doc.lines.map((l) => ({
    ...lineTotals({
      qty: l.qty,
      unitPriceIncl: l.unitPriceIncl,
      discountPct: l.discountPct,
      discountIncl: Math.abs(l.discountIncl) > 0.005 ? Math.abs(l.discountIncl) : undefined,
      vatRatePct: l.vatRatePct,
    }),
    vatRatePct: l.vatRatePct,
  }))
  const totals = documentTotals(computed)

  return {
    proForma: false,
    gift: opts.gift ?? false,
    siteName: site.name,
    vatNumber: site.vatNumber?.trim() || null,
    documentNumber: doc.documentNumber,
    documentDate: doc.documentDate,
    printedAt: opts.printedAt,
    cashierName: doc.userName,
    terminalCode: doc.terminalCode,
    customerName: doc.customerName?.trim() || null,
    customerVatNo: doc.customerVatNo?.trim() || null,
    lines: doc.lines.map((l) => ({
      description: l.description,
      qty: Math.abs(l.qty),
      unitPriceIncl: l.unitPriceIncl,
      lineTotalIncl: Math.abs(l.lineTotalIncl),
      notes: receiptNotes(l.instructions),
    })),
    subtotalExcl: doc.subtotalExcl,
    vatTotal: doc.vatTotal,
    discountTotal: doc.discountTotal,
    totalIncl: doc.totalIncl,
    roundingAdj: doc.roundingAdj,
    vatByRate: totals.vatByRate,
    tenders,
    changeGiven: doc.changeGiven,
    loyalty: opts.loyalty ?? null,
    copyNumber: opts.copyNumber ?? 0,
    footerText: opts.footerText ?? '',
  }
}

/**
 * The OFFLINE slip, from what the till holds at finalise.
 *
 * Built BEFORE the basket clears, from the same arithmetic the queued sale
 * carries — so the paper handed over and the document that posts at sync
 * agree by construction. No loyalty (a server-side fact) and copy 0.
 */
export function receiptDataFromBasket(input: {
  siteName: string
  vatNumber: string | null
  documentNumber: string
  documentDate: string
  printedAt: string
  cashierName: string
  terminalCode: string | null
  customerName: string | null
  lines: {
    description: string
    qty: number
    unitPriceIncl: number
    discountPct?: number
    discountIncl?: number
    vatRatePct: number
    instructions?: readonly SlipInstruction[]
    note?: string | null
  }[]
  tenders: ReceiptTender[]
  changeGiven: number
  roundingAdj?: number
  footerText?: string
  gift?: boolean
}): ReceiptData {
  const computed = input.lines.map((l) => ({
    ...lineTotals({
      qty: l.qty,
      unitPriceIncl: l.unitPriceIncl,
      discountPct: l.discountPct,
      discountIncl: l.discountIncl,
      vatRatePct: l.vatRatePct,
    }),
    vatRatePct: l.vatRatePct,
  }))
  const totals = documentTotals(computed)

  return {
    proForma: false,
    gift: input.gift ?? false,
    siteName: input.siteName,
    vatNumber: input.vatNumber?.trim() || null,
    documentNumber: input.documentNumber,
    documentDate: input.documentDate,
    printedAt: input.printedAt,
    cashierName: input.cashierName,
    terminalCode: input.terminalCode,
    customerName: input.customerName?.trim() || null,
    customerVatNo: null,
    lines: input.lines.map((l, index) => ({
      description: l.description,
      qty: Math.abs(l.qty),
      unitPriceIncl: l.unitPriceIncl,
      lineTotalIncl: Math.abs(computed[index].lineTotalIncl),
      notes: receiptNotes(l.instructions, l.note),
    })),
    subtotalExcl: totals.subtotalExcl,
    vatTotal: totals.vatTotal,
    discountTotal: totals.discountTotal,
    /* EXACT, with the cash rounding shown as its own row — the same rule the
       posted document keeps: the invoice stays R100.02 even when the drawer
       took R100.00. */
    totalIncl: totals.totalIncl,
    roundingAdj: input.roundingAdj ?? 0,
    vatByRate: totals.vatByRate,
    tenders: input.tenders,
    changeGiven: input.changeGiven,
    loyalty: null,
    copyNumber: 0,
    footerText: input.footerText ?? '',
  }
}
