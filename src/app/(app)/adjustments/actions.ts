'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule, actorForModuleOrThrow } from '@/lib/auth'
import {
  postNewAdjustment,
  saveAdjustment,
  postAdjustment,
  cancelAdjustment,
  deleteAdjustment,
  pilesFor,
  saveReason,
  deleteReason,
  type AdjustmentInput,
  type ReasonInput,
} from '@/lib/site/stockAdjustments'
import { searchForTill } from '@/lib/site/tillSearch'
import { availableSerials } from '@/lib/site/serials'

export type AdjustmentActionResult =
  | { ok: true; id: number; documentNumber: string }
  | { ok: false; error: string }

/**
 * Posting moves stock, so every screen that reads a pile has to be revalidated:
 * the product pages show the per-location breakdown, and the till reads the
 * main location.
 */
function revalidateStock() {
  revalidatePath('/adjustments')
  revalidatePath('/products')
}

/** Captures and posts in one click, for the new-adjustment screen. */
export async function postNewAdjustmentAction(
  input: AdjustmentInput,
): Promise<AdjustmentActionResult> {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await postNewAdjustment(siteId, actor, input)
  if (!result.ok) return result

  revalidateStock()
  return result
}

/** Keeps the capture without moving anything, for a clear-out done over a day. */
export async function saveDraftAdjustmentAction(
  input: AdjustmentInput,
  id?: number,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await saveAdjustment(siteId, actor, input, id)
  if (!result.ok) return result

  // A draft moves nothing, so only the list needs to know it exists.
  revalidatePath('/adjustments')
  return result
}

export async function postAdjustmentAction(id: number): Promise<AdjustmentActionResult> {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await postAdjustment(siteId, actor, id)
  if (!result.ok) return result

  revalidateStock()
  return result
}

export async function cancelAdjustmentAction(
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await cancelAdjustment(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidateStock()
  return { ok: true }
}

export async function deleteAdjustmentAction(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx

  const result = await deleteAdjustment(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/adjustments')
  return { ok: true }
}

/* ── Lookups for the capture screen ──────────────────────────────────────── */

export async function searchProductsForAdjustmentAction(term: string) {
  const { siteId } = await actorForModuleOrThrow('inventory_advanced', 'stock.view')
  return searchForTill(siteId, term, null)
}

/**
 * What the chosen location holds for the products already on the screen.
 *
 * One call for the whole grid rather than one per line — the same reasoning as
 * reservedQtyFor(). Returned as an array because a Map is awkward to rely on
 * across the action boundary, and the caller rebuilds one anyway.
 */
export async function pilesForAdjustmentAction(locationId: number, productIds: number[]) {
  const { siteId } = await actorForModuleOrThrow('inventory_advanced', 'stock.view')
  const piles = await pilesFor(siteId, locationId, productIds)
  return [...piles.values()]
}

/**
 * The individual units in one room, for a serialised line being written off.
 *
 * postAdjustment refuses a serial line that does not name its units, so the
 * screen has to offer the actual units — and only the ones in the room being
 * adjusted.
 */
export async function serialsInLocationAction(productId: number, locationId: number) {
  const { siteId } = await actorForModuleOrThrow('inventory_advanced', 'stock.view')
  const units = await availableSerials(siteId, productId, locationId)
  return units.map((s) => ({ id: s.id, serial: s.serial }))
}

/* ── Reasons ─────────────────────────────────────────────────────────────── */

export async function saveReasonAction(
  input: ReasonInput,
  id?: number,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx

  const result = await saveReason(ctx.siteId, input, id)
  if (!result.ok) return result

  revalidatePath('/adjustments')
  revalidatePath('/setup/adjustment-reasons')
  return result
}

export async function deleteReasonAction(
  id: number,
): Promise<{ ok: true; retired: boolean } | { ok: false; error: string }> {
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteReason(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/adjustments')
  revalidatePath('/setup/adjustment-reasons')
  return result
}
