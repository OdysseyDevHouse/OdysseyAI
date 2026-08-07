'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { logActivity } from '@/lib/site/activityLog'
import {
  setCustomerLogin,
  setCustomerLoginActive,
  type SaveResult,
} from '@/lib/site/customerAuth'

/**
 * Staff managing a customer's online sign-in.
 *
 * Guarded on `customers.edit`, not on an online-store capability: this grants
 * somebody the ability to place orders that charge the account, which is a
 * decision about the customer relationship rather than about the shop's web
 * presence.
 *
 * Both are AUDITED. Giving or withdrawing the ability to buy on credit online
 * is exactly the kind of change a shop needs to be able to look back at.
 */

export async function setOnlineAccessAction(
  customerId: number,
  email: string,
  password: string,
): Promise<SaveResult> {
  const ctx = await actorFor('customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setCustomerLogin(siteId, customerId, email, password)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: customerId,
    action: 'online_access',
    // The email, never the password — an activity log is read by more people
    // than the customer record is.
    detail: `Online store access set for ${email.trim().toLowerCase()}`,
  })

  revalidatePath(`/customers/${customerId}`)
  return { ok: true }
}

export async function setOnlineAccessActiveAction(
  customerId: number,
  active: boolean,
): Promise<SaveResult> {
  const ctx = await actorFor('customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await setCustomerLoginActive(siteId, customerId, active)
  if (!result.ok) return result

  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: customerId,
    action: 'online_access',
    detail: active ? 'Online store access restored' : 'Online store access withdrawn',
  })

  revalidatePath(`/customers/${customerId}`)
  return { ok: true }
}
