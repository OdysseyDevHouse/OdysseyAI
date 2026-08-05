'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteId, requireActor } from '@/lib/auth'
import { postTransfer, voidTransfer, type TransferInput } from '@/lib/site/stockTransfers'
import { searchForTill } from '@/lib/site/tillSearch'
import { locationStockFor } from '@/lib/site/stockLocations'
import { availableSerials } from '@/lib/site/serials'

export type TransferActionResult =
  | { ok: true; id: number; documentNumber: string }
  | { ok: false; error: string }

/**
 * Posting moves stock, so every screen that reads a pile has to be
 * revalidated: the product pages show the breakdown, and the till reads the
 * main location.
 */
function revalidateStock() {
  revalidatePath('/transfers')
  revalidatePath('/products')
}

export async function postTransferAction(input: TransferInput): Promise<TransferActionResult> {
  const { siteId, actor } = await requireActor()
  const result = await postTransfer(siteId, actor, input)
  if (!result.ok) return result

  revalidateStock()
  return result
}

export async function voidTransferAction(
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { siteId, actor } = await requireActor()
  const result = await voidTransfer(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidateStock()
  return { ok: true }
}

/** Product search for the transfer screen. */
export async function searchProductsForTransferAction(term: string) {
  const siteId = await requireSiteId()
  return searchForTill(siteId, term, null)
}

/**
 * What a product holds in each location.
 *
 * The transfer screen needs the FROM pile specifically — moving 10 out of a
 * room holding 3 is refused at post, and showing the figure while the line is
 * being typed is what stops it being attempted.
 */
export async function locationStockAction(productId: number) {
  const siteId = await requireSiteId()
  return locationStockFor(siteId, productId)
}

/**
 * The individual units sitting in one room, for a serialised line.
 *
 * A serial product cannot be transferred by quantity alone — postTransfer
 * refuses it — so the screen has to offer the actual units to pick from, and
 * only the ones in the room the stock is leaving.
 */
export async function serialsInLocationAction(productId: number, locationId: number) {
  const siteId = await requireSiteId()
  const units = await availableSerials(siteId, productId, locationId)
  return units.map((s) => ({ id: s.id, serial: s.serial }))
}
