'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, actorForOrThrow } from '@/lib/auth'
import {
  postBuild,
  unbuild,
  previewBuild,
  listManufacturableProducts,
  type BuildInput,
} from '@/lib/site/manufacturing'

export type BuildActionResult =
  | { ok: true; id: number; documentNumber: string }
  | { ok: false; error: string }

/**
 * A build moves stock on both sides, so every screen that reads a pile has to
 * be revalidated — the product pages show the breakdown, and the till reads the
 * main location.
 */
function revalidateStock() {
  revalidatePath('/manufacturing')
  revalidatePath('/products')
}

export async function postBuildAction(input: BuildInput): Promise<BuildActionResult> {
  // The check belongs here and not only on the screen that offered the button.
  // A server action is a public endpoint: hiding a button changes what is easy,
  // not what is possible.
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await postBuild(siteId, actor, input)
  if (!result.ok) return result

  revalidateStock()
  return result
}

export async function unbuildAction(
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await unbuild(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidateStock()
  revalidatePath(`/manufacturing/${id}`)
  return { ok: true }
}

/**
 * What a build would consume and whether there is enough.
 *
 * Called as the quantity is typed, so the panel a user reads and the check that
 * refuses the post come from the same function and cannot disagree.
 */
export async function previewBuildAction(
  productId: number,
  qty: number,
  fromLocationId: number,
) {
  const ctx = await actorForOrThrow('products.view')
  return previewBuild(ctx.siteId, productId, qty, fromLocationId)
}

/** The product picker on the capture screen — manufactured recipes only. */
export async function searchManufacturableAction(term: string) {
  const ctx = await actorForOrThrow('products.view')
  return listManufacturableProducts(ctx.siteId, term)
}
