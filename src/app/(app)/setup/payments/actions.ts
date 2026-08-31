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
  /*
   * `setup.edit`, and NO module gate — see the page's header.
   *
   * The gateway is not a storefront feature: an invoice pay link, a statement
   * QR and a lay-by instalment all need it, and a shop without the online-store
   * module needs it just as much. The capability is still asserted HERE, since
   * the action is the boundary and a moved route changes nothing about that.
   */
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

  revalidatePath('/setup/payments')
  revalidatePath('/setup')
  // The storefront's own setup screen shows whether a gateway is connected.
  revalidatePath('/online-store/setup')
  return { ok: true }
}
