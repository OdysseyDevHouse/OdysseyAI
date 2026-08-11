'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { createReferRange, type ReferRangeInput } from '@/lib/site/referRange'

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
