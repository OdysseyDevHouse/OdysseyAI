'use server'

import { revalidatePath } from 'next/cache'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { getCustomerSession } from '@/lib/customerSession'
import {
  saveCustomerAddress,
  deleteCustomerAddress,
  type CustomerAddressInput,
} from '@/lib/site/customerAddresses'

/**
 * The shopper's own delivery address book. The customer id comes from the
 * SESSION on every call — never the payload — and the storefront may only
 * touch delivery addresses; billing stays staff-managed.
 */

async function sessionFor(token: string) {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return null
  const context = await storefrontContext(siteId)
  if (!context || !context.settings.allowAccount) return null
  const session = await getCustomerSession(siteId)
  return session ? { siteId, session } : null
}

const ONLINE_ACTOR = { userId: 0, userName: 'Online customer' }

export async function saveAddressAction(
  token: string,
  input: Omit<CustomerAddressInput, 'kind'>,
  id?: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = await sessionFor(token)
  if (!store) return { ok: false, error: 'Please sign in again.' }
  const result = await saveCustomerAddress(
    store.siteId,
    ONLINE_ACTOR,
    store.session.customerId,
    { ...input, kind: 'delivery' },
    id,
  )
  if (!result.ok) return result
  revalidatePath(`/store/${token}/account/addresses`)
  return { ok: true }
}

export async function deleteAddressAction(
  token: string,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = await sessionFor(token)
  if (!store) return { ok: false, error: 'Please sign in again.' }
  const result = await deleteCustomerAddress(store.siteId, ONLINE_ACTOR, store.session.customerId, id)
  if (!result.ok) return result
  revalidatePath(`/store/${token}/account/addresses`)
  return { ok: true }
}
