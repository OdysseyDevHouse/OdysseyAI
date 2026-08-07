'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  createVatRate,
  updateVatRate,
  deleteVatRate,
  createPriceStructure,
  updatePriceStructure,
  deletePriceStructure,
  reorderPriceStructures,
  type VatRateInput,
  type PriceStructureInput,
} from '@/lib/site/pricingSetup'
import { planReprice, applyReprice, type RepriceScope } from '@/lib/site/reprice'
import type { RepriceRule } from '@/lib/repricing'
import { logActivity } from '@/lib/site/activityLog'

export type PricingActionResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * Both lists feed the product form and the till, so every path below
 * revalidates products as well as this screen — a renamed price type that
 * still reads "Wholesale" on the product page is how a user stops trusting a
 * save.
 */
function revalidate() {
  revalidatePath('/setup/pricing')
  revalidatePath('/products')
}

export async function saveVatRateAction(
  id: number | null,
  input: VatRateInput,
): Promise<PricingActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = id ? await updateVatRate(siteId, id, input) : await createVatRate(siteId, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidate()
  return { ok: true, message: id ? 'VAT rate updated.' : 'VAT rate added.' }
}

export async function deleteVatRateAction(id: number): Promise<PricingActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteVatRate(ctx.siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidate()
  return { ok: true, message: 'VAT rate removed.' }
}

export async function savePriceStructureAction(
  id: number | null,
  input: PriceStructureInput,
): Promise<PricingActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = id
    ? await updatePriceStructure(siteId, id, input)
    : await createPriceStructure(siteId, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidate()
  return { ok: true, message: id ? 'Price type updated.' : 'Price type added.' }
}

export async function deletePriceStructureAction(id: number): Promise<PricingActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await deletePriceStructure(ctx.siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidate()
  return { ok: true, message: 'Price type removed.' }
}

export async function reorderPriceStructuresAction(
  orderedIds: number[],
): Promise<PricingActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await reorderPriceStructures(ctx.siteId, orderedIds)
  revalidate()
  return { ok: true, message: 'Order saved.' }
}

/* ── Bulk repricing ──────────────────────────────────────────────────────── */

export type RepricePreview = {
  considered: number
  changing: number
  unchanged: number
  skipped: number
  /** First few changes, for the table. The plan itself covers everything. */
  sample: {
    code: string
    description: string
    currentIncl: number | null
    newIncl: number
  }[]
  /** Distinct skip reasons with counts, so the user sees WHY without a list. */
  skipReasons: { reason: string; count: number }[]
}

export type RepricePreviewResult =
  | { ok: true; preview: RepricePreview }
  | { ok: false; error: string }

const SAMPLE_SIZE = 12

export async function previewRepriceAction(
  scope: RepriceScope,
  rule: RepriceRule,
): Promise<RepricePreviewResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const plan = await planReprice(ctx.siteId, scope, rule)
  const changing = plan.changes.filter((c) => c.changed)

  const byReason = new Map<string, number>()
  for (const s of plan.skips) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1)

  return {
    ok: true,
    preview: {
      considered: plan.considered,
      changing: changing.length,
      unchanged: plan.changes.length - changing.length,
      skipped: plan.skips.length,
      sample: changing.slice(0, SAMPLE_SIZE).map((c) => ({
        code: c.code,
        description: c.description,
        currentIncl: c.currentIncl,
        newIncl: c.newIncl,
      })),
      skipReasons: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
  }
}

/**
 * Applies a reprice.
 *
 * Re-plans from scratch rather than taking prices from the client. The preview
 * the user approved is a rendering of a rule, not a payload to trust — a posted
 * list of product ids and prices would be an open invitation to set any price
 * on any product, and `setup.edit` is a much broader group than that deserves.
 */
export async function applyRepriceAction(
  scope: RepriceScope,
  rule: RepriceRule,
): Promise<PricingActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const plan = await planReprice(siteId, scope, rule)
  const result = await applyReprice(siteId, scope.targetStructureId, plan.changes)
  if (!result.ok) return { ok: false, error: result.error }

  if (result.written > 0) {
    // entityId null: this is a catalogue-wide event, not an edit to one
    // product. "Why is everything R2 more this morning" needs an answer.
    await logActivity(siteId, actor, {
      entity: 'product',
      entityId: null,
      action: 'reprice',
      detail: `${result.written} price${result.written === 1 ? '' : 's'} updated by bulk reprice — ${describeRule(rule)}`,
    })
  }

  revalidate()
  return {
    ok: true,
    message:
      result.written === 0
        ? 'Nothing to change — every price already matches the rule.'
        : `${result.written} price${result.written === 1 ? '' : 's'} updated.`,
  }
}

/** A one-line account of the rule, for the audit trail. */
function describeRule(rule: RepriceRule): string {
  const source = rule.source.kind === 'cost' ? 'cost' : `price type ${rule.source.structureId}`
  const method =
    rule.method.kind === 'markup'
      ? `${rule.method.percent}% markup`
      : rule.method.kind === 'gp'
        ? `${rule.method.percent}% GP`
        : `${rule.method.percent}% adjustment`
  const rounding =
    rule.rounding.kind === 'ending'
      ? `, ending .${String(rule.rounding.cents).padStart(2, '0')}`
      : rule.rounding.kind === 'nearest'
        ? `, to nearest ${rule.rounding.step}`
        : ''
  return `${method} on ${source}${rounding}`
}
