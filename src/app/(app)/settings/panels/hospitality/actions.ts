'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting } from '@/lib/site/settings'
import { siteExecute, siteQueryOne } from '@/lib/siteDb'
import { listServiceTiers } from '@/lib/site/tips'
import { overlappingTiers } from '@/lib/tipMath'
import type { ServiceTier, ServiceChargeKind } from '@/lib/tipMath'

/**
 * Configuring tips.
 *
 * Guarded on `setup.edit`, like the tender types and the tables beside it: deciding what a
 * shop charges is configuration, where taking payment is selling. A waiter who may ring up
 * a bill has no business changing the service charge mid-service.
 *
 * Every mutation returns the whole fresh list, for the same reason the quick-key designer
 * and the floor plan do — the server orders and validates, so a client applying its own
 * guess drifts from what the till will actually charge.
 */

export type TierRow = ServiceTier & { id: number }

export type TiersResult =
  | { ok: true; tiers: TierRow[]; tablesOnly: boolean; overlaps: number }
  | { ok: false; error: string }

async function state(siteId: number): Promise<TiersResult> {
  const tiers = await listServiceTiers(siteId)
  const stored = await siteQueryOne<{ setting_value: string }>(
    siteId,
    "SELECT setting_value FROM settings WHERE setting_key = 'tips_tables_only'",
  )
  return {
    ok: true,
    tiers,
    /* Absent means ON — the same defaulting `serviceChargeForBill` applies, restated here
       rather than imported because this is the SCREEN's reading of an unset setting and
       the two must agree. */
    tablesOnly: stored === null ? true : String(stored.setting_value) !== '0',
    /* Reported, not refused. A manager mid-edit will always have a moment where two bands
       overlap, and blocking the save would make the screen unusable — so the count is
       shown and `serviceChargeFor` resolves deterministically to the higher percentage. */
    overlaps: overlappingTiers(tiers).length,
  }
}

export async function loadTiersAction(): Promise<TiersResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  return state(ctx.siteId)
}

function validate(input: {
  minTotal: number
  maxTotal: number | null
  chargeKind: ServiceChargeKind
  percent: number
  amount: number
}): string | null {
  if (!Number.isFinite(input.minTotal) || input.minTotal < 0) {
    return 'The band must start at zero or more.'
  }
  if (input.maxTotal !== null) {
    if (!Number.isFinite(input.maxTotal)) return 'That upper limit is not a number.'
    /* Equal is refused as well as inverted: a band from 500 to 500 is half-open, so it
       matches nothing at all and would sit on the screen looking configured. */
    if (input.maxTotal <= input.minTotal) {
      return 'The upper limit must be above the lower one.'
    }
  }

  /* Only the figure this band actually charges is checked. Validating both would refuse a
     perfectly good flat-amount band for the 0 sitting in the percent column it ignores. */
  if (input.chargeKind === 'amount') {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return 'Give the band an amount.'
    }
    /* No upper bound to match the percentage's "not more than the bill": a flat charge is
       compared against a bill whose value is not known until the till adds one up, and the
       band's own lower limit is where a shop says which bills it applies to. */
    return null
  }

  if (!Number.isFinite(input.percent) || input.percent <= 0) {
    return 'Give the band a percentage.'
  }
  /* A service charge above 100% of the bill is a keying error, not a policy. Refused
     rather than clamped, because a charge silently reduced to 100% is still absurd. */
  if (input.percent > 100) return 'A service charge cannot be more than the bill.'
  return null
}

export async function saveTierAction(input: {
  id?: number
  minTotal: number
  maxTotal: number | null
  chargeKind: ServiceChargeKind
  percent: number
  amount: number
  isActive: boolean
}): Promise<TiersResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const invalid = validate(input)
  if (invalid) return { ok: false, error: invalid }

  /* Both columns are written every time, and the one this band does not use is zeroed
     rather than left as it was. A band switched from 10% to R25 that kept its old percent
     would read correctly on screen and still be one misread `charge_kind` away from
     charging the wrong thing — so the stored row says only what the band actually does. */
  const percent = input.chargeKind === 'percent' ? input.percent : 0
  const amount = input.chargeKind === 'amount' ? input.amount : 0

  if (input.id) {
    await siteExecute(
      ctx.siteId,
      `UPDATE service_charge_tiers
          SET min_total = ?, max_total = ?, charge_kind = ?, percent = ?, charge_amount = ?, is_active = ?
        WHERE id = ?`,
      [
        input.minTotal.toFixed(2),
        input.maxTotal === null ? null : input.maxTotal.toFixed(2),
        input.chargeKind,
        percent.toFixed(3),
        amount.toFixed(2),
        input.isActive ? 1 : 0,
        input.id,
      ],
    )
  } else {
    await siteExecute(
      ctx.siteId,
      `INSERT INTO service_charge_tiers (min_total, max_total, charge_kind, percent, charge_amount, is_active)
       VALUES (?,?,?,?,?,?)`,
      [
        input.minTotal.toFixed(2),
        input.maxTotal === null ? null : input.maxTotal.toFixed(2),
        input.chargeKind,
        percent.toFixed(3),
        amount.toFixed(2),
        input.isActive ? 1 : 0,
      ],
    )
  }

  revalidatePath('/settings')
  /* The TILL reads the tiers on every bill, and its page is cached — without this a waiter
     keeps charging yesterday's percentages until something else revalidates. */
  revalidatePath('/pos')
  return state(ctx.siteId)
}

export async function deleteTierAction(id: number): Promise<TiersResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  /* Deleted outright rather than deactivated. A tier carries no history — the CHARGES it
     produced are `sales_tips` rows with their own amounts, so removing the band cannot
     orphan or restate anything already taken. */
  await siteExecute(ctx.siteId, 'DELETE FROM service_charge_tiers WHERE id = ?', [id])
  revalidatePath('/settings')
  revalidatePath('/pos')
  return state(ctx.siteId)
}

export async function setTablesOnlyAction(tablesOnly: boolean): Promise<TiersResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await setSetting(ctx.siteId, 'tips_tables_only', tablesOnly ? '1' : '0')
  revalidatePath('/settings')
  revalidatePath('/pos')
  return state(ctx.siteId)
}
