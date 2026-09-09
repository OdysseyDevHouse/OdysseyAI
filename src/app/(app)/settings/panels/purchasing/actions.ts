'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { getSetting, setSetting } from '@/lib/site/settings'

/**
 * How this shop buys and costs stock.
 *
 * Three settings that were readable and not writable: the code has consulted
 * all of them for a long time, but nothing put a control on a screen, so
 * changing one meant an UPDATE against the settings table.
 *
 * They are guarded on `setup.edit` rather than `purchasing.edit`. Cost basis in
 * particular is not a purchasing decision — it moves every margin, GP report
 * and till cost in the system at once — and a buyer who may raise an order has
 * no business restating the shop's whole cost history from a receiving screen.
 */

export type PurchasingSettings = {
  costBasis: 'average' | 'last'
  invoiceTolerance: string
  costWarnPct: string
  approvalThreshold: string
}

export type PurchasingSettingsResult =
  | { ok: true; settings: PurchasingSettings }
  | { ok: false; error: string }

async function state(siteId: number): Promise<PurchasingSettingsResult> {
  const [costBasis, invoiceTolerance, costWarnPct, approvalThreshold] = await Promise.all([
    getSetting(siteId, 'cost_basis'),
    getSetting(siteId, 'purchase_invoice_tolerance'),
    getSetting(siteId, 'purchase_cost_change_warn_pct'),
    getSetting(siteId, 'purchase_approval_threshold'),
  ])

  return {
    ok: true,
    settings: {
      // Anything other than the two known values reads as 'last' — the default
      // a site is created with, so the screen shows what the rest of the app is
      // actually costing from rather than a second opinion.
      costBasis: costBasis === 'average' ? 'average' : 'last',
      invoiceTolerance,
      costWarnPct,
      approvalThreshold,
    },
  }
}

export async function loadPurchasingSettingsAction(): Promise<PurchasingSettingsResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  return state(ctx.siteId)
}

/**
 * Saves all three at once.
 *
 * One action rather than three, because the screen has a single Save: a
 * partial write would leave the cost basis changed and the guard that protects
 * it not, with nothing on screen saying which of the two took.
 *
 * setSetting validates each key and refuses a bad value, so the first failure
 * stops the rest — a tolerance typo must not still flip the cost basis.
 */
export async function savePurchasingSettingsAction(input: {
  costBasis: string
  invoiceTolerance: string
  costWarnPct: string
  approvalThreshold: string
}): Promise<PurchasingSettingsResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const writes = [
    ['cost_basis', input.costBasis],
    ['purchase_invoice_tolerance', input.invoiceTolerance],
    ['purchase_cost_change_warn_pct', input.costWarnPct],
    ['purchase_approval_threshold', input.approvalThreshold],
  ] as const

  const basisBefore = await getSetting(ctx.siteId, 'cost_basis').catch(() => null)

  for (const [key, value] of writes) {
    const result = await setSetting(ctx.siteId, key, value)
    if (!result.ok) return result
  }

  /*
   * ── CHANGING THE BASIS RESTATES EVERY COMPOSED COST ──────────────────────
   *
   * A recipe's stored cost is a cache of compositionCost(), which sums its
   * ingredients out of the column cost_basis names. Flipping the basis
   * re-points that read at the OTHER column, so every recipe and every pack is
   * now caching a figure derived from a column nothing reads any more — and no
   * individual product changed, so the ordinary cascade never fires.
   *
   * Measured on a fixture across a basis flip: the till charged 600 while the
   * catalogue and every report still stored 200. That is the same
   * stored-vs-live divergence the cascade exists to prevent, arriving through
   * the one door it did not watch.
   *
   * Only when the basis actually MOVED. Saving this screen to change the
   * invoice tolerance must not walk the whole catalogue.
   *
   * Never fails the save: the settings are written and correct either way, and
   * a recipe that cannot be resolved keeps the stored figure it had.
   */
  if (basisBefore !== null && basisBefore !== input.costBasis) {
    const { recostAllComposed } = await import('@/lib/site/productComposition')
    await recostAllComposed(ctx.siteId).catch(() => 0)
  }

  revalidatePath('/settings')
  /* Cost basis is read by the RECEIVING screen and by the till catalogue, both
     of which are cached. Without these a buyer keeps seeing yesterday's basis
     in the margin columns until something else revalidates them. */
  revalidatePath('/purchasing/receive')
  revalidatePath('/products')
  revalidatePath('/pos')
  /* The approval threshold decides whether a draft's Issue button is live, and
     that is computed on the document page. Without this, raising the limit
     leaves a buyer still blocked on an order that no longer needs signing. */
  revalidatePath('/purchasing', 'layout')

  return state(ctx.siteId)
}
