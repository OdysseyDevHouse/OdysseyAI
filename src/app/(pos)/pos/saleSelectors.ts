import { lineTotals, documentTotals, apportionDiscount } from '@/lib/documentMath'
import { round } from '@/lib/decimals'
import {
  computeSpecials,
  effectiveDiscountPct,
  type Special,
  type PricingContext,
} from '@/lib/specialsEngine'
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

/**
 * The basket as the specials engine should see it.
 *
 * ── A REWARD LINE IS NOT AN INPUT ────────────────────────────────────────
 *
 * Lines the engine itself granted go in at quantity zero. They keep their slot
 * so results stay index-aligned with the basket, but they must not count
 * towards anything: the engine's own docblock warns that feeding rewards back
 * in inflates the deal count, and since this runs on every keystroke that
 * inflation would compound — two pizzas earn a bread, the bread helps earn
 * another, and the basket fills with free food.
 *
 * Zeroed rather than filtered, because filtering would shift every index after
 * the removed line and silently apply discounts to the wrong goods.
 */
function engineLines(lines: BasketLine[]) {
  return lines.map((line) => ({
    productId: line.productId ?? -1,
    departmentId: line.departmentId,
    priceIncl: line.unitPriceIncl,
    /* A refund goes in at zero for the same reason — goods coming back neither
       qualify for a deal nor earn one; a three-for-two must not be completed
       by a return.

       `Math.max(qty, 0)` is what does it, and it is load-bearing now rather than
       defensive: a refund line on an ordinary slip carries a NEGATIVE quantity
       (see `refundArmed` in useSaleState), so without the clamp a returned item
       would count DOWNWARDS against a "buy 3" threshold and a customer handing
       one back could undo a deal they had already earned on the same slip. */
    qty: line.rewardSpecialId !== undefined ? 0 : Math.max(line.qty, 0),
    /*
     * What the margin guards need, and the till already has.
     *
     * Both ride on every basket line and are cached offline, so a special that
     * refuses to sell below cost does so with the network gone — which is
     * exactly when nobody is watching the numbers.
     */
    costExcl: line.unitCostExcl,
    maxDiscountPct: line.maxDiscountPct,
  }))
}

/** Per-line specials for a basket, index-aligned with it. */
export function specialsFor(
  lines: BasketLine[],
  specials: Special[],
  now: Date,
  /** Who is being served. Omitted means a walk-in — see PricingContext. */
  context?: PricingContext,
) {
  if (specials.length === 0) return lines.map(() => undefined)
  return computeSpecials(engineLines(lines), specials, now, context).lineSpecials
}

/**
 * The products this basket has earned for nothing.
 *
 * Separate from `specialsFor` rather than returned beside it, because the two
 * are consumed differently: the discounts are index-aligned with the lines and
 * read on every render, while the rewards CHANGE the lines and so must be
 * applied through the reducer. One function returning both would tempt a caller
 * into doing the second during the first, which is a render that writes state.
 */
export function rewardsFor(
  lines: BasketLine[],
  specials: Special[],
  now: Date,
  context?: PricingContext,
) {
  if (specials.length === 0) return []
  return computeSpecials(engineLines(lines), specials, now, context).rewards
}

export type SaleTotals = ReturnType<typeof totalsFor>

/**
 * A whole-sale discount, before it is spread onto the lines.
 *
 * Null is "none". A percent applies to the basket's NET (after line discounts
 * and specials — a doc discount on top of a promotion is explicit stacking the
 * cashier can see in the preview, never a silent compound inside one line);
 * an amount is clamped to the net so a R100 discount on a R60 basket credits
 * nothing.
 */
export type DocDiscount = { kind: 'percent' | 'amount'; value: number } | null

/**
 * Each line's share of a document-level discount, index-aligned.
 *
 * documentMath rule 3 does the spreading: pro-rata by net value, remainder to
 * the largest line, so the shares sum to EXACTLY the discount asked for.
 * `eligibleKeys` narrows it (a discount code scoped to a department) — an
 * ineligible line's share is zero, and the amount spreads over the rest.
 */
export function docDiscountShares(
  lines: BasketLine[],
  lineSpecials: ReturnType<typeof specialsFor>,
  docDiscount: DocDiscount,
  eligibleKeys?: ReadonlySet<string>,
): number[] {
  if (!docDiscount || docDiscount.value <= 0 || lines.length === 0) {
    return lines.map(() => 0)
  }

  const netTotals = lines.map((line, index) =>
    lineTotals({
      qty: line.qty,
      unitPriceIncl: line.unitPriceIncl,
      discountPct: effectiveDiscountPct(line.discountPct, lineSpecials[index]),
      vatRatePct: line.vatRatePct,
    }).lineTotalIncl,
  )

  const eligible = lines.map(
    (line, index) =>
      (eligibleKeys === undefined || eligibleKeys.has(line.key)) && netTotals[index] > 0,
  )
  const eligibleNet = round(
    netTotals.reduce((sum, value, index) => (eligible[index] ? sum + value : sum), 0),
    2,
  )
  if (eligibleNet <= 0) return lines.map(() => 0)

  const amount =
    docDiscount.kind === 'percent'
      ? round((eligibleNet * docDiscount.value) / 100, 2)
      : Math.min(round(docDiscount.value, 2), eligibleNet)
  if (amount <= 0) return lines.map(() => 0)

  // Apportion over the eligible subset, then map back to full-basket indices.
  const subset = netTotals.filter((_, index) => eligible[index])
  const shares = apportionDiscount(subset, amount)
  let cursor = 0
  return lines.map((_, index) => (eligible[index] ? shares[cursor++] : 0))
}

/**
 * The figures on screen.
 *
 * A special and a cashier's own discount do NOT stack — the better of the two
 * applies. Compounding them is how a staff discount during a promotion quietly
 * sells below cost, and `effectiveDiscountPct` is the one place that decision
 * lives.
 *
 * `docShares` (a document-level discount already apportioned by
 * `docDiscountShares`) folds each line's share into an absolute `discountIncl`
 * — line discount plus share — which `lineTotals` prefers over the percentage.
 * Absent, behaviour is byte-identical to before the parameter existed.
 */
export function totalsFor(
  lines: BasketLine[],
  lineSpecials: ReturnType<typeof specialsFor>,
  docShares?: number[],
) {
  const perLine = lines.map((line, index) => {
    const pct = effectiveDiscountPct(line.discountPct, lineSpecials[index])
    const share = docShares?.[index] ?? 0
    const ownDiscount = round(round(line.qty * line.unitPriceIncl, 2) * (pct / 100), 2)
    return {
      ...lineTotals({
        qty: line.qty,
        unitPriceIncl: line.unitPriceIncl,
        discountPct: pct,
        ...(share > 0 ? { discountIncl: round(ownDiscount + share, 2) } : {}),
        vatRatePct: line.vatRatePct,
      }),
      vatRatePct: line.vatRatePct,
    }
  })
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
  /** A doc-level discount's per-line shares — same array totalsFor was given. */
  docShares?: number[],
  /** Stamped on the ELIGIBLE lines when a discount code paid for the shares. */
  discountCodeId?: number | null,
) {
  return lines.map((line, index) => {
    const pct = effectiveDiscountPct(line.discountPct, lineSpecials[index])
    const share = docShares?.[index] ?? 0
    const ownDiscount = round(round(line.qty * line.unitPriceIncl, 2) * (pct / 100), 2)
    return {
      productId: line.productId,
      productCode: line.productCode,
      description: line.description,
      productType: line.productType,
      departmentId: line.departmentId,
      qty: line.qty,
      unitPriceIncl: line.unitPriceIncl,
      discountPct: pct,
      /* The absolute discount wins server-side when present — same rule as
         lineTotals. Emitted only when a share exists, so a sale with no doc
         discount is byte-identical to before this parameter existed. */
      ...(share > 0 ? { discountIncl: round(ownDiscount + share, 2) } : {}),
      ...(share > 0 && discountCodeId ? { discountCodeId } : {}),
      /* A reward line records the special that PUT it here. It carries no
         discount of its own — it is free rather than reduced — so without this
         the one line the promotion actually gave away would be the one line
         with no trace of which promotion gave it. */
      specialId: line.rewardSpecialId ?? lineSpecials[index]?.specialId ?? null,
      vatRatePct: line.vatRatePct,
      unitCostExcl: line.unitCostExcl,
      /* The answers, and the note. This whitelist is the ONLY thing that reaches
         the server from a basket line, online and offline alike — a field left out
         here is one that vanishes silently at finalise. */
      instructions: line.instructions,
      note: line.note,
      // The card a gift-card line sells (147). Whitelisted here or it would
      // vanish silently at finalise — see the comment above.
      ...(line.giftCardCode ? { giftCardCode: line.giftCardCode } : {}),
      /* The lot this line was sold from (234). Whitelisted for the same
         reason, and it matters on the PARK and RECALL paths especially: a
         table bill rewrites its lines wholesale on every save, so a lot
         survives a recall only because it makes this round trip. Left off
         entirely when nothing was captured, so a FEFO shop's payload is
         byte-identical to before this existed. */
      ...(line.batchNo ? { batchNo: line.batchNo } : {}),
      /* The unit this line sells (235). Whitelisted for the same reason as
         everything above it — and here the cost of forgetting is not a lost
         note but a sale refused at the tender pad, which is the bug this
         whole change exists to close. */
      ...(line.serialId ? { serialId: line.serialId } : {}),
      /* When the line was first rung (167). Whitelisted for the same reason,
         and it MATTERS most on the save path a table takes: that rewrites the
         bill's lines wholesale, so a line's order time is only preserved
         because it makes this round trip. Left off entirely when unknown, so
         the column stays NULL rather than claiming the epoch. */
      ...(line.orderedAt ? { orderedAt: line.orderedAt } : {}),
    }
  })
}

/**
 * The same basket, as RETURN lines.
 *
 * Three deliberate differences from `salePayloadLines`, and each one is a decision:
 *
 *   · NO discountPct and NO specialId. A credit note reverses what a customer paid, and
 *     a discount is already baked into the price they paid — `unitPriceIncl` carries it.
 *     Sending a discount as well would credit it twice. `CreditLineInput` has no
 *     discount field at all, which is the same conclusion reached server-side.
 *   · NO specials engine argument. A basket of goods coming back earns no promotion —
 *     see PosShell, which passes an empty specials list in return mode, so there would be
 *     nothing to read here anyway. Not taking the parameter makes that structural rather
 *     than conventional.
 *   · qty stays POSITIVE. `createCreditNote` stores it negative and is the only thing
 *     that should know the convention; a negative here would double-negate into a sale.
 */
export function returnPayloadLines(lines: BasketLine[]) {
  return lines.map((line) => ({
    productId: line.productId,
    productCode: line.productCode,
    description: line.description,
    productType: line.productType,
    departmentId: line.departmentId,
    qty: Math.abs(line.qty),
    unitPriceIncl: line.unitPriceIncl,
    vatRatePct: line.vatRatePct,
    /*
     * The cost as the TILL knows it.
     *
     * The online credit note copies this from the original invoice line, because
     * re-reading the product would value a return at today's cost and manufacture margin
     * never earned. With no receipt there is no original line to copy from, so the
     * catalog's cost is the closest honest answer available — and it is recorded as what
     * was used rather than silently re-derived later.
     */
    unitCostExcl: line.unitCostExcl,
    /*
     * The lot off the pack (236).
     *
     * A whitelist of its own, with the same failure mode as
     * `salePayloadLines`: a field left out here is shown on screen and never
     * sent. And this is the path where the lot matters MOST — an offline
     * return is always the no-receipt case, so there is no original line to
     * mirror and the alternative is the newest-lot guess.
     */
    ...(line.batchNo ? { batchNo: line.batchNo } : {}),
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
