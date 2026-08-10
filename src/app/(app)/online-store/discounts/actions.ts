'use server'

import { revalidatePath } from 'next/cache'
import { requireCapability } from '@/lib/auth'
import { saveCode, type DiscountCodeInput } from '@/lib/site/discountCodes'
import { siteExecute } from '@/lib/siteDb'

/**
 * The discounts screen's server actions.
 *
 * Guarded with `online_store.manage` — the same capability the rest of the
 * section uses. The screen is only reachable from a menu someone with it can
 * see, but a hidden screen is not a boundary: these are POST endpoints anyone
 * can call, and the action is where the check has to live.
 */

type Result = { ok: true; id?: number } | { ok: false; error: string }

export async function saveDiscountAction(
  id: number | null,
  input: DiscountCodeInput,
): Promise<Result> {
  const { siteId, actor } = await requireCapability('online.edit')
  const result = await saveCode(siteId, id, input, actor.userName)
  if (!result.ok) return result
  revalidatePath('/online-store/discounts')
  return { ok: true, id: result.id }
}

/**
 * Retire a code rather than delete it.
 *
 * Deleting one would take its redemptions with it (the ledger CASCADEs), and
 * those rows are what answer "what did that campaign cost us" long after the
 * campaign ended. Switching it off stops it being accepted and keeps the
 * history readable — the same reasoning as archiving a product.
 */
export async function retireDiscountAction(id: number): Promise<Result> {
  const { siteId, actor } = await requireCapability('online.edit')
  await siteExecute(
    siteId,
    'UPDATE discount_codes SET is_active = 0, updated_by = ? WHERE id = ?',
    [actor.userName.slice(0, 120), id],
  )
  revalidatePath('/online-store/discounts')
  return { ok: true }
}

export async function reviveDiscountAction(id: number): Promise<Result> {
  const { siteId, actor } = await requireCapability('online.edit')
  await siteExecute(
    siteId,
    'UPDATE discount_codes SET is_active = 1, updated_by = ? WHERE id = ?',
    [actor.userName.slice(0, 120), id],
  )
  revalidatePath('/online-store/discounts')
  return { ok: true }
}
