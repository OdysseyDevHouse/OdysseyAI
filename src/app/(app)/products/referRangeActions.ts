'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  createReferRange,
  referChain,
  addReferRung,
  removeReferRung,
  setReferGroupMethod,
  type ReferRangeInput,
  type AddRungInput,
  type ChainRung,
} from '@/lib/site/referRange'
import type { ReferMethod } from '@/lib/site/productComposition'

/**
 * The refer wizard's one action.
 *
 * Re-checks `products.edit` rather than trusting that the dialog only opened
 * for someone who has it — a hidden dialog is not a boundary, and this is a
 * POST endpoint anybody can call.
 *
 * The whole range is created in one transaction inside createReferRange, so
 * this returns either every product id or an error and nothing written.
 */
export async function createReferRangeAction(
  input: ReferRangeInput,
): Promise<{ ok: true; productIds: number[]; created: number } | { ok: false; error: string }> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await createReferRange(ctx.siteId, input)
  if (!result.ok) return result

  revalidatePath('/products')
  return result
}

/*
 * The Refer tab's own actions.
 *
 * The panel edits a chain rather than filling in a field, so it saves itself
 * the way Variants and Serials do — adding a pack size CREATES A PRODUCT, and
 * that cannot wait for the form's Save button. Each one re-reads the chain
 * afterwards so the panel and the database cannot disagree after a partial
 * failure.
 */

export async function referChainAction(
  productId: number,
): Promise<{ ok: true; chain: ChainRung[] } | { ok: false; error: string }> {
  const ctx = await actorFor('products.view')
  if ('ok' in ctx) return ctx
  return { ok: true, chain: await referChain(ctx.siteId, productId) }
}

export async function addReferRungAction(
  input: AddRungInput,
  /**
   * Which rung's screen we are on.
   *
   * The chain has to come back marked for THAT product, not for the one just
   * created — otherwise adding a case from the six-pack's screen relabels the
   * case as "This product" and the panel disagrees with the page it is on.
   */
  viewingId: number,
): Promise<{ ok: true; chain: ChainRung[] } | { ok: false; error: string }> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await addReferRung(ctx.siteId, input)
  if (!result.ok) return result

  revalidatePath('/products')
  return { ok: true, chain: await referChain(ctx.siteId, viewingId) }
}

/**
 * Switches the refer method for every product linked to this one.
 *
 * Set from one stock code, applied to the whole group — a ladder running two
 * methods at once receives stock at one level and looks for it at another. See
 * setReferGroupMethod.
 */
export async function setReferMethodAction(
  productId: number,
  method: ReferMethod,
): Promise<{ ok: true; chain: ChainRung[]; changed: number } | { ok: false; error: string }> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await setReferGroupMethod(ctx.siteId, productId, method)
  if (!result.ok) return result

  revalidatePath('/products')
  return { ok: true, chain: await referChain(ctx.siteId, productId), changed: result.changed }
}

export async function removeReferRungAction(
  productId: number,
  /** Which rung's screen we are on, so the chain comes back for THAT one. */
  viewingId: number,
): Promise<{ ok: true; chain: ChainRung[] } | { ok: false; error: string }> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await removeReferRung(ctx.siteId, productId)
  if (!result.ok) return result

  revalidatePath('/products')
  return { ok: true, chain: await referChain(ctx.siteId, viewingId) }
}
