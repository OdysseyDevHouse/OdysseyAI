'use server'

import { revalidatePath } from 'next/cache'
import { actorForOrThrow } from '@/lib/auth'
import {
  saveBulkPrices,
  type BulkPriceEdit,
  type BulkPricingSaveResult,
} from '@/lib/site/bulkPricing'

/**
 * Saves the prices edited on the bulk pricing grid.
 *
 * Returns its result rather than redirecting, the same as the other bulk
 * actions, so the grid can toast what happened and clear only the rows that
 * actually saved.
 *
 * The structure id comes from the client, so saveBulkPrices checks it against
 * the active price types rather than trusting it — a stale tab holding a
 * deleted structure must not write prices under it.
 */
export async function saveBulkPricesAction(
  structureId: number,
  edits: BulkPriceEdit[],
): Promise<BulkPricingSaveResult> {
  const { siteId, actor } = await actorForOrThrow('products.edit')

  const result = await saveBulkPrices(siteId, structureId, edits, actor)

  // The product list and any product screen show these prices too.
  revalidatePath('/products')
  revalidatePath('/products/bulk-pricing')
  return result
}
