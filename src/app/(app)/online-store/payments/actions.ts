'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import { saveGateway, type GatewayInput, type SaveResult } from '@/lib/site/payments'

/**
 * Connecting the store's payment account.
 *
 * The credentials never come back out to the browser once saved — the form
 * sends them in, and the screen thereafter only ever shows whether an account
 * is connected. Audited because switching a store to live payments, or away
 * from them, is a decision someone may have to answer for.
 */
export async function saveGatewayAction(input: GatewayInput): Promise<SaveResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await saveGateway(siteId, input, actor.userName)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'online_store',
    entityId: null,
    action: 'payment_gateway',
    detail: input.isActive
      ? `PayFast connected (${input.isSandbox ? 'TEST mode' : 'live'})`
      : 'PayFast disconnected',
  })

  revalidatePath('/online-store/payments')
  revalidatePath('/online-store/setup')
  return { ok: true }
}
