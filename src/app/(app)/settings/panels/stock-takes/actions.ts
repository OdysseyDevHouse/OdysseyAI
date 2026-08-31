'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { getSetting, setSetting } from '@/lib/site/settings'

/**
 * When a count variance needs a second signature.
 *
 * Guarded on `setup.edit` rather than `stock.adjust`, and deliberately so: this
 * screen is where the line is DRAWN, and somebody who can move the line can
 * step over it. The whole control rests on the person counting not being the
 * person who decides what counts as large.
 *
 * Same reasoning that puts the cost basis behind setup.edit rather than
 * purchasing.edit — a control is only worth what the weakest way of changing
 * it is worth.
 */

export type StockTakeSettings = {
  varianceQtyPct: string
  varianceValue: string
}

export type StockTakeSettingsResult =
  | { ok: true; settings: StockTakeSettings }
  | { ok: false; error: string }

async function state(siteId: number): Promise<StockTakeSettingsResult> {
  const [varianceQtyPct, varianceValue] = await Promise.all([
    getSetting(siteId, 'stock_take_variance_qty_pct'),
    getSetting(siteId, 'stock_take_variance_value'),
  ])
  return { ok: true, settings: { varianceQtyPct, varianceValue } }
}

export async function loadStockTakeSettingsAction(): Promise<StockTakeSettingsResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  return state(ctx.siteId)
}

/**
 * Saves both at once.
 *
 * One action rather than two, because the screen has a single Save and the two
 * thresholds are one control with two instruments — a partial write would leave
 * a shop gating on value and not percentage with nothing on screen saying which
 * of the two took.
 *
 * setSetting validates each key and refuses a bad value, so a typo in one stops
 * the other rather than half-applying.
 */
export async function saveStockTakeSettingsAction(input: {
  varianceQtyPct: string
  varianceValue: string
}): Promise<StockTakeSettingsResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const writes = [
    ['stock_take_variance_qty_pct', input.varianceQtyPct],
    ['stock_take_variance_value', input.varianceValue],
  ] as const

  for (const [key, value] of writes) {
    const result = await setSetting(ctx.siteId, key, value)
    if (!result.ok) return result
  }

  revalidatePath('/settings')
  /* Every open sheet recomputes which of its lines are held the moment these
     move. Without this, lowering a threshold leaves a counter looking at a post
     button that is still refused for lines that no longer cross the line — and
     raising one leaves lines flagged that no longer need to be. */
  revalidatePath('/stock-takes', 'layout')

  return state(ctx.siteId)
}
