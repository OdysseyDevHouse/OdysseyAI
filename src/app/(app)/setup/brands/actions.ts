'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  createBrand,
  updateBrand,
  deleteBrand,
  setBrandActive,
  type BrandInput,
} from '@/lib/site/brands'

/**
 * Maintaining the brand list.
 *
 * Thin, because every rule that matters — the name clash, the length bound, the
 * refusal to delete a brand still carried by products — lives in
 * lib/site/brands.ts and is shared with the inline creator on the product form.
 *
 * `setup.edit` for the maintenance screen: renaming a brand renames it on every
 * product at once and on every report that groups by it, which is a
 * configuration decision rather than day-to-day catalogue work. The page guards
 * on the same capability, but the action is the real boundary — a page guard
 * only stops navigation, not a POST.
 */

export type BrandActionResult = { ok: true; id: number } | { ok: false; error: string }
export type BrandInlineResult = { ok: true } | { ok: false; error: string }

/**
 * Which screens go stale when a brand changes.
 *
 * Every product screen renders the brand picker or filters by it, and the
 * commission, stock-take and reprice screens all scope by brand — so a renamed
 * or deactivated brand that only refreshed this page would keep offering the
 * old list everywhere it actually gets used.
 */
function revalidateBrandScreens(): void {
  revalidatePath('/setup/brands')
  revalidatePath('/products')
  revalidatePath('/products/new')
  revalidatePath('/setup/pricing')
  revalidatePath('/commission/rules')
  revalidatePath('/stock-takes')
}

export async function saveBrandAction(
  input: BrandInput,
  id?: number,
): Promise<BrandActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = id
    ? await updateBrand(ctx.siteId, id, input)
    : await createBrand(ctx.siteId, input)
  if (!result.ok) return result

  revalidateBrandScreens()
  return result
}

export async function setBrandActiveAction(
  id: number,
  isActive: boolean,
): Promise<BrandInlineResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await setBrandActive(ctx.siteId, id, isActive)
  if (!result.ok) return result

  revalidateBrandScreens()
  return result
}

export async function deleteBrandAction(id: number): Promise<BrandInlineResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  // Refuses rather than cascades when products still carry the brand — the FK
  // is ON DELETE SET NULL, so deleting one in use would quietly unbrand every
  // product on it. The message names the count and offers deactivating.
  const result = await deleteBrand(ctx.siteId, id)
  if (!result.ok) return result

  revalidateBrandScreens()
  return result
}

/**
 * Creating a brand from somewhere that is not this screen — today, the
 * "<Create new>" option on the product form's Brand picker.
 *
 * Its own action rather than a flag on saveBrandAction for two reasons. It
 * guards on `products.edit`, not `setup.edit`: somebody filing products should
 * be able to name a brand that is missing without being handed the rights to
 * rename every brand in the catalogue. And it only CREATES — renaming from
 * inside a product form would rename the brand on every product that uses it
 * while looking like an edit to the one on screen.
 *
 * Returns the new id because the caller needs it: the product form has to
 * select what was just created, and a bare ok/error cannot say which row it
 * made.
 */
export type CreateBrandResult =
  | { ok: true; id: number; name: string }
  | { ok: false; error: string }

export async function createBrandInlineAction(input: {
  name: string
}): Promise<CreateBrandResult> {
  const ctx = await actorFor('products.edit')
  if ('ok' in ctx) return ctx

  const result = await createBrand(ctx.siteId, { name: input.name, isActive: true })
  if (!result.ok) return { ok: false, error: result.error }

  revalidateBrandScreens()
  return { ok: true, id: result.id, name: input.name.trim() }
}
