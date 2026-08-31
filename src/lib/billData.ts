import { documentTotals, lineTotals } from './documentMath'
import type { SalesDocument } from './site/salesDocuments'

/**
 * A pro-forma bill, as data.
 *
 * Pure and layout-free on purpose: the browser print page renders this today,
 * and the ESC/POS renderer (Phase 6) will consume the SAME object — one
 * builder, two printers, and a bill that cannot disagree with itself between
 * them.
 *
 * Deliberately not `server-only`: it takes an already-fetched document, so a
 * client renderer can share it without dragging the database along.
 *
 * ── THIS IS NOT A TAX INVOICE ─────────────────────────────────────────────
 *
 * A saved bill has NO document number — numbers are minted at finalise — and
 * that absence is load-bearing: nothing fiscal can leak onto a slip for a sale
 * that has not happened yet. The `proForma` flag is always true and exists so
 * the renderer's "not a tax invoice" banner is driven by data, not memory.
 */

export type BillLine = {
  description: string
  qty: number
  unitPriceIncl: number
  lineTotalIncl: number
  /** Instruction answers marked prints_on_receipt — "no onions", "extra shot". */
  notes: string[]
}

export type BillData = {
  proForma: true
  siteName: string
  vatNumber: string | null
  /** What this business calls its tax. Absent falls back to VAT. */
  taxLabel?: string
  /** The tab's label — the table code, or whatever the waiter typed. */
  label: string
  covers: number | null
  userName: string
  /** Wall-clock string, passed in so two slips printed an hour apart differ. */
  printedAt: string
  lines: BillLine[]
  subtotalExcl: number
  vatTotal: number
  discountTotal: number
  totalIncl: number
  vatByRate: { ratePct: number; excl: number; vat: number; incl: number }[]
}

export function billDataFor(
  doc: SalesDocument,
  site: { name: string; vatNumber: string | null; taxLabel?: string },
  opts: { printedAt: string },
): BillData {
  const computed = doc.lines.map((l) => ({
    ...lineTotals({
      qty: l.qty,
      unitPriceIncl: l.unitPriceIncl,
      discountPct: l.discountPct,
      vatRatePct: l.vatRatePct,
    }),
    vatRatePct: l.vatRatePct,
  }))
  const totals = documentTotals(computed)

  return {
    proForma: true,
    siteName: site.name,
    vatNumber: site.vatNumber?.trim() || null,
    taxLabel: site.taxLabel,
    label: doc.customerName?.trim() || 'Table',
    covers: doc.personCount,
    userName: doc.userName,
    printedAt: opts.printedAt,
    lines: doc.lines.map((l) => ({
      description: l.description,
      qty: Math.abs(l.qty),
      unitPriceIncl: l.unitPriceIncl,
      lineTotalIncl: l.lineTotalIncl,
      notes: (l.instructions ?? [])
        .filter((i) => i.printsOnReceipt)
        .map((i) => (i.qty > 1 ? `${i.qty} × ${i.optionName}` : i.optionName)),
    })),
    subtotalExcl: totals.subtotalExcl,
    vatTotal: totals.vatTotal,
    discountTotal: totals.discountTotal,
    totalIncl: totals.totalIncl,
    vatByRate: totals.vatByRate,
  }
}
