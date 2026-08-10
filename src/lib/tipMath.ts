import { round } from './decimals'

/**
 * What counts as a tip, and how much.
 *
 * PURE, and no `server-only` — the same reason `documentMath` and `tenderMath` are: the
 * till computes what it puts on the slip and the server recomputes it at finalise, and a
 * second implementation is how a printed slip and a posted invoice come to disagree about
 * money. Offline this is the only copy that runs.
 *
 * ── THE THREE SHAPES OF A TIP ─────────────────────────────────────────────
 *
 *   OVER-TENDER   A tender that gives no change, paid over the bill. R120 on R100 is a
 *                 R20 tip, unambiguously, because there is no change to give.
 *   DECLARED      Cash. R100 on R50 might be R50 change, or R10 tip and R40 change —
 *                 nothing can infer which, so a person says.
 *   SERVICE       A percentage of the bill, from a tier table. Added before payment
 *                 rather than derived from it, because the customer is told the total.
 *
 * ── WHAT A TIP IS NOT ─────────────────────────────────────────────────────
 *
 * VATable. A gratuity is not consideration for goods, so no rate is applied anywhere in
 * this file. Nothing here touches the invoice total either — `assertBalanced` would catch
 * that, and it should.
 */

export type TenderTipRules = {
  /** `tender_types.allows_change`. Cash does; card and account do not. */
  allowsChange: boolean
  /** `tender_types.tip_on_over_tender`. Off means an over-tender is a mistake. */
  tipOnOverTender: boolean
  /** `tender_types.tip_in_drawer`. Whether cash-up should expect it at the till. */
  tipInDrawer: boolean
}

/**
 * How an over-tender on one payment method splits.
 *
 * The whole decision table, in one place:
 *
 *   allowsChange  tipOnOverTender  →  the excess is
 *   ------------  ---------------     -------------------------------------------
 *   true          (either)            CHANGE. Cash always gives change back unless
 *                                     somebody declares otherwise — see declareTip.
 *   false         true                a TIP.
 *   false         false               NEITHER: it is an error the pad must refuse,
 *                                     because keeping R20 somebody fat-fingered is
 *                                     worse than telling them the amount is wrong.
 */
export type OverTenderOutcome =
  | { kind: 'change'; amount: number }
  | { kind: 'tip'; amount: number }
  | { kind: 'refuse'; amount: number }

export function splitOverTender(
  owed: number,
  tendered: number,
  rules: TenderTipRules,
): OverTenderOutcome {
  const excess = round(Math.max(0, tendered - owed), 2)
  if (excess <= 0.005) return { kind: 'change', amount: 0 }
  if (rules.allowsChange) return { kind: 'change', amount: excess }
  if (rules.tipOnOverTender) return { kind: 'tip', amount: excess }
  return { kind: 'refuse', amount: excess }
}

/**
 * Splits cash handed over into tip and change, given a declared tip.
 *
 * Clamped rather than refused: a declared tip larger than the excess would give change
 * back out of the shop's own money, which is a keying error rather than a generous
 * customer. Clamping keeps the drawer honest and the pad then shows a smaller tip than
 * was typed, which is visible and correctable.
 */
export function declareTip(
  owed: number,
  tendered: number,
  declared: number,
): { tip: number; change: number } {
  const excess = round(Math.max(0, tendered - owed), 2)
  const tip = round(Math.min(Math.max(0, declared), excess), 2)
  return { tip, change: round(excess - tip, 2) }
}

/* ── Service charge ──────────────────────────────────────────────────────── */

export type ServiceTier = {
  /** Inclusive. */
  minTotal: number
  /** EXCLUSIVE, or null for the open-ended top band. */
  maxTotal: number | null
  percent: number
  isActive: boolean
}

/**
 * The service charge a bill earns, or zero.
 *
 * `min` inclusive and `max` EXCLUSIVE, so bands that meet at a round number cannot both
 * match: 500–1000 and 1000–1500 meet at exactly 1000 and the second owns it. Getting that
 * wrong would double-charge every bill landing on a boundary, which is precisely where
 * round numbers cluster.
 *
 * The HIGHEST matching band wins when a shop has left overlapping ranges configured. That
 * is a deliberate choice for a broken configuration: charging the higher percentage is
 * visible to the customer and gets reported, where silently charging the lower one hides
 * the misconfiguration for months.
 */
export function serviceChargeFor(total: number, tiers: readonly ServiceTier[]): number {
  if (!Number.isFinite(total) || total <= 0) return 0

  let best: ServiceTier | null = null
  for (const tier of tiers) {
    if (!tier.isActive) continue
    if (total < tier.minTotal) continue
    if (tier.maxTotal !== null && total >= tier.maxTotal) continue
    if (!best || tier.percent > best.percent) best = tier
  }
  if (!best) return 0
  return round((total * best.percent) / 100, 2)
}

/**
 * Whether the tiers a shop has configured overlap.
 *
 * Not enforced at save time — a manager mid-edit will always have a moment where two
 * bands overlap, and refusing the save would make the screen unusable. Reported instead,
 * so the setup screen can say so and `serviceChargeFor` can pick deterministically.
 */
export function overlappingTiers(tiers: readonly ServiceTier[]): [ServiceTier, ServiceTier][] {
  const active = tiers.filter((t) => t.isActive)
  const clashes: [ServiceTier, ServiceTier][] = []
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]
      const aMax = a.maxTotal ?? Number.POSITIVE_INFINITY
      const bMax = b.maxTotal ?? Number.POSITIVE_INFINITY
      // Half-open ranges: they overlap when each starts before the other ends.
      if (a.minTotal < bMax && b.minTotal < aMax) clashes.push([a, b])
    }
  }
  return clashes
}

/* ── Cash-up ─────────────────────────────────────────────────────────────── */

export type TipForDrawer = { amount: number; tipInDrawer: boolean }

/**
 * How much of a shift's tips the DRAWER should contain.
 *
 * The reason this function exists rather than a `SUM(amount)`: a cash tip is physically in
 * the till and must be expected, while a card or account tip is not — it arrives through
 * the card machine or a debtor's account and is paid out through payroll. Summing all tips
 * would leave every card-tipping shift reading over by its card tips, and summing none
 * would leave every cash-tipping shift reading over by its cash ones. Both are the same
 * bug in opposite directions, which is why the flag is per tender and not a global.
 */
export function tipsInDrawer(tips: readonly TipForDrawer[]): number {
  return round(
    tips.reduce((sum, t) => (t.tipInDrawer ? sum + t.amount : sum), 0),
    2,
  )
}
