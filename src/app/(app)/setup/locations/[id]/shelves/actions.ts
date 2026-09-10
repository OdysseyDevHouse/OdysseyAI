'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import {
  createShelf,
  updateShelf,
  deleteShelf,
  createBin,
  updateBin,
  deleteBin,
  reorderShelves,
  reorderBins,
  type ShelfInput,
  type BinInput,
} from '@/lib/site/stockBins'

export type ShelfActionResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * Every action revalidates the product and stock-take screens as well as this one.
 *
 * A shelf is a column on the product page and the sort key of a count sheet, so
 * renaming one or dragging it up the walk order changes what those pages render.
 * Leaving them cached would offer a bin that no longer exists under that name.
 */
function revalidateShelves(locationId: number) {
  revalidatePath(`/setup/locations/${locationId}/shelves`)
  revalidatePath('/setup/locations')
  revalidatePath('/products')
  revalidatePath('/stock-takes')
}

export async function saveShelfAction(
  locationId: number,
  id: number | null,
  input: ShelfInput,
): Promise<ShelfActionResult> {
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = id
    ? await updateShelf(siteId, id, input)
    : await createShelf(siteId, locationId, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidateShelves(locationId)
  return { ok: true, message: id ? 'Shelf updated.' : 'Shelf added.' }
}

export async function deleteShelfAction(
  locationId: number,
  id: number,
): Promise<ShelfActionResult> {
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await deleteShelf(siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidateShelves(locationId)
  return { ok: true, message: 'Shelf removed.' }
}

export async function saveBinAction(
  locationId: number,
  shelfId: number,
  id: number | null,
  input: BinInput,
): Promise<ShelfActionResult> {
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = id ? await updateBin(siteId, id, input) : await createBin(siteId, shelfId, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidateShelves(locationId)
  return { ok: true, message: id ? 'Bin updated.' : 'Bin added.' }
}

export async function deleteBinAction(locationId: number, id: number): Promise<ShelfActionResult> {
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await deleteBin(siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidateShelves(locationId)
  return { ok: true, message: 'Bin removed. Anything in it is now placed on the shelf.' }
}

/**
 * The walk order.
 *
 * Its own action rather than a field on the save, because dragging is a
 * different act from editing: it happens to several rows at once and it must not
 * open a dialog. The message names the consequence, since the effect of dragging
 * a shelf is invisible on this screen and shows up on the next count sheet.
 */
export async function reorderShelvesAction(
  locationId: number,
  orderedIds: number[],
): Promise<ShelfActionResult> {
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  await reorderShelves(siteId, orderedIds)
  revalidateShelves(locationId)
  return { ok: true, message: 'Walk order saved — new count sheets follow it.' }
}

export async function reorderBinsAction(
  locationId: number,
  orderedIds: number[],
): Promise<ShelfActionResult> {
  const ctx = await actorForModule('inventory_advanced', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  await reorderBins(siteId, orderedIds)
  revalidateShelves(locationId)
  return { ok: true, message: 'Bin order saved.' }
}
