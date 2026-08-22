import { documentTotals, lineTotals } from './documentMath'
import { round } from './decimals'
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
  /**
   * What came off this line, and why.
   *
   * BOTH figures, because they answer different questions: the percentage is
   * the claim the shop advertised ("20% off"), the rand amount is what this
   * customer actually saved on this line. A slip carrying only one of them
   * makes the customer do arithmetic to check the other.
   *
   * `discountPct` is the EFFECTIVE percentage — a special and a manual
   * discount do NOT compound, so it is whichever of the two won (see
   * effectiveDiscountPct). Zero on an undiscounted line, which is what keeps
   * the renderers' `> 0` guards honest.
   *
   * `specialName` names the promotion when one is what discounted the line,
   * null when a cashier did it by hand. The till already draws exactly this
   * distinction on its line badge; the paper should not be vaguer than the
   * screen the customer watched.
   */
  discountPct: number
  discountIncl: number
  specialName: string | null
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
  /**
   * Where a QR block on the slip may point.
   *
   * Carried on the receipt rather than read by the renderer, which has no
   * database and must not grow one — the same discipline that keeps
   * slipSpec.ts a pure function of what it is handed. Absent means a QR block
   * has nowhere to point and prints nothing.
   */
  qrLinks?: { appUrl: string | null; storeUrl: string | null; reviewUrl: string | null }
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
    /**
     * Special id → name, for the per-line "why" (see ReceiptLine.specialName).
     *
     * Passed in rather than joined onto the line, because `getDocument` also
     * serves the in-store box, and the box holds ten tables — none of them
     * `specials` (see scripts/box-migrate.mjs). A join there would break every
     * tab read to name a promotion that only a finalised slip prints.
     *
     * Omitted means "no names available", not "no specials": the lines still
     * print their discount, just without a promotion's name against it.
     */
    specialNames?: ReadonlyMap<number, string>
    /** Where a QR block on this slip may point — see ReceiptData.qrLinks. */
    qrLinks?: ReceiptData['qrLinks']
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
    lines: doc.lines.map((l, index) => ({
      description: l.description,
      qty: Math.abs(l.qty),
      unitPriceIncl: l.unitPriceIncl,
      lineTotalIncl: Math.abs(l.lineTotalIncl),
      discountPct: Math.abs(l.discountPct),
      /* The RECOMPUTED amount, not the stored column, and for the same reason
         the VAT split above is recomputed: `computed` already resolved the
         "absolute wins over percentage" rule, so a line discounted by pct
         alone still reports rands here instead of the zero the column holds. */
      discountIncl: Math.abs(computed[index].discountIncl),
      specialName: (l.specialId !== null ? opts.specialNames?.get(l.specialId) : null) ?? null,
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
    ...(opts.qrLinks ? { qrLinks: opts.qrLinks } : {}),
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
    /** The promotion that discounted this line, when one did. See ReceiptLine. */
    specialName?: string | null
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
      /*
       * DERIVED when only an amount was given, not echoed back.
       *
       * A line can be discounted either way: a percentage the cashier typed, or
       * an absolute amount (a document discount's apportioned share, or a
       * discount code's). The posted builder reads a stored `discount_pct` that
       * the sale engine worked out either way, so it always has one — and this
       * builder, echoing its input, printed "0% off" on exactly the lines
       * discounted by amount.
       *
       * Which made the offline slip and the posted slip disagree about the same
       * sale: paper handed over at the counter claiming 0%, and a reprint after
       * sync claiming 8%. `lineTotals` has already resolved the amount, so the
       * percentage is arithmetic rather than a second source of truth.
       *
       * FALSY, not nullish — and that distinction is the whole fix. The caller
       * this exists for is PosShell's snapshot, which passes
       * `salePayloadLines` output; that always emits `discountPct`, as 0 on
       * exactly the doc-discount-share line described above. A `??` here reads
       * that 0 as "stated" and echoes it straight back, so the bug survives on
       * the one path it was written for. A stated 0 and an absent one make the
       * same claim — nothing came off by percentage — and neither is worth
       * printing when rands did come off.
       *
       * A caller stating a REAL percentage still wins: it is not falsy.
       */
      discountPct: Math.abs(
        l.discountPct ||
          (computed[index].grossIncl > 0
            ? round((computed[index].discountIncl / computed[index].grossIncl) * 100, 3)
            : 0),
      ),
      discountIncl: Math.abs(computed[index].discountIncl),
      specialName: l.specialName ?? null,
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
