import { lineTotals, documentTotals } from '@/lib/documentMath'
import { computeSpecials, effectiveDiscountPct, type Special } from '@/lib/specialsEngine'
import type { BasketLine } from '@/lib/basket'
import type { Department } from './types'

/**
 * Everything the till DERIVES from the basket, rather than stores.
 *
 * Deliberately outside the reducer. A reducer that also computed totals would
 * have to recompute them on every action, and — worse — would make the totals a
 * thing that could be stale: two sources for one number is how a slip and a
 * screen come to disagree.
 *
 * Every function here is pure, and the money ones are thin wrappers over
 * documentMath and specialsEngine — the same modules the server recomputes with
 * at finalise. That is not tidiness; it is why an offline sale's figures match
 * what the server works out at sync, by construction rather than by luck.
 */

/** Per-line specials for a basket, index-aligned with it. */
export function specialsFor(lines: BasketLine[], specials: Special[], now: Date) {
  if (specials.length === 0) return lines.map(() => undefined)
  return computeSpecials(
    lines.map((line) => ({
      productId: line.productId ?? -1,
      departmentId: line.departmentId,
      priceIncl: line.unitPriceIncl,
      /*
       * A refund line goes in at zero.
       *
       * It keeps its slot so the results stay index-aligned with the basket, but
       * goods coming back neither qualify for a deal nor earn one — a
       * three-for-two must not be completed by a return.
       */
      qty: Math.max(line.qty, 0),
    })),
    specials,
    now,
  ).lineSpecials
}

export type SaleTotals = ReturnType<typeof totalsFor>

/**
 * The figures on screen.
 *
 * A special and a cashier's own discount do NOT stack — the better of the two
 * applies. Compounding them is how a staff discount during a promotion quietly
 * sells below cost, and `effectiveDiscountPct` is the one place that decision
 * lives.
 */
export function totalsFor(
  lines: BasketLine[],
  lineSpecials: ReturnType<typeof specialsFor>,
) {
  const perLine = lines.map((line, index) => ({
    ...lineTotals({
      qty: line.qty,
      unitPriceIncl: line.unitPriceIncl,
      discountPct: effectiveDiscountPct(line.discountPct, lineSpecials[index]),
      vatRatePct: line.vatRatePct,
    }),
    vatRatePct: line.vatRatePct,
  }))
  return { perLine, doc: documentTotals(perLine) }
}

/**
 * The lines to send when saving or finalising.
 *
 * `discountPct` is the EFFECTIVE one — what the screen showed — so the slip the
 * customer was handed and the sale the server posts cannot disagree about the
 * price. The server still re-derives every total from these lines and re-checks
 * the discount against the operator's rights; this is what was charged, not a
 * claim about what the total is.
 */
export function salePayloadLines(
  lines: BasketLine[],
  lineSpecials: ReturnType<typeof specialsFor>,
) {
  return lines.map((line, index) => ({
    productId: line.productId,
    productCode: line.productCode,
    description: line.description,
    productType: line.productType,
    departmentId: line.departmentId,
    qty: line.qty,
    unitPriceIncl: line.unitPriceIncl,
    discountPct: effectiveDiscountPct(line.discountPct, lineSpecials[index]),
    specialId: lineSpecials[index]?.specialId ?? null,
    vatRatePct: line.vatRatePct,
    unitCostExcl: line.unitCostExcl,
  }))
}

/* ── The department tree ─────────────────────────────────────────────────── */

/**
 * The children of one department, ordered the way the back office ordered them.
 *
 * sortOrder first, then name: a store that has bothered to arrange its
 * departments expects that arrangement on the till, and one that has not gets
 * alphabetical rather than insertion order, which reads as random.
 */
export function childDepartments(all: Department[], parentId: number | null): Department[] {
  return all
    .filter((d) => d.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

/** The departments named by a drill path, root first — for the breadcrumb. */
export function departmentTrail(all: Department[], path: number[]): Department[] {
  return path
    .map((id) => all.find((d) => d.id === id))
    .filter((d): d is Department => d !== undefined)
}

/**
 * Whether a department has children.
 *
 * Decides whether its tile promises a further screen. A chevron on a leaf is a
 * promise the till cannot keep, and the reference POS is explicit that this is
 * worth getting right: tapping it should show products, not an empty grid.
 */
export function hasChildren(all: Department[], id: number): boolean {
  return all.some((d) => d.parentId === id)
}
