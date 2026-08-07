'use server'

import { revalidatePath } from 'next/cache'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import {
  changeCustomerPassword,
  signInCustomer,
  type SaveResult,
} from '@/lib/site/customerAuth'
import {
  clearCustomerCookie,
  createCustomerToken,
  getCustomerSession,
  setCustomerCookie,
} from '@/lib/customerSession'

/**
 * Signing a customer in and out of a storefront.
 *
 * ── THE TOKEN IS RESOLVED HERE, EVERY TIME ───────────────────────────────
 *
 * These are public HTTP endpoints. The page that renders the form checked the
 * token, but that protects the page — a script can post here directly with any
 * token it likes, so the store is resolved again from scratch on every call.
 *
 * ── AND SO IS THE STORE'S SETTING ────────────────────────────────────────
 *
 * A shop with accounts switched off must not authenticate anyone, however the
 * request arrived.
 */

async function storeFor(token: string) {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return null
  const context = await storefrontContext(siteId)
  return context ? { siteId, context } : null
}

export async function signInAction(
  token: string,
  email: string,
  password: string,
): Promise<SaveResult> {
  const store = await storeFor(token)
  // Same wording as a bad password: whether a shop takes account orders at all
  // is not something a sign-in form should confirm.
  if (!store) return { ok: false, error: 'That email and password do not match an account.' }
  if (!store.context.settings.allowAccount) {
    return { ok: false, error: 'That email and password do not match an account.' }
  }

  const result = await signInCustomer(store.siteId, email, password)
  if (!result.ok) return result

  await setCustomerCookie(
    await createCustomerToken({
      siteId: store.siteId,
      customerId: result.identity.customerId,
      name: result.identity.customerName,
      mustChange: result.identity.mustChange,
    }),
  )
  revalidatePath(`/store/${token}`, 'layout')
  return { ok: true }
}

export async function signOutAction(token: string): Promise<void> {
  await clearCustomerCookie()
  revalidatePath(`/store/${token}`, 'layout')
}

export async function changePasswordAction(
  token: string,
  current: string,
  next: string,
): Promise<SaveResult> {
  const store = await storeFor(token)
  if (!store) return { ok: false, error: 'This shop is not available.' }

  // The customer id comes from the SESSION, never from the caller — otherwise
  // this would change any customer's password given their id.
  const session = await getCustomerSession(store.siteId)
  if (!session) return { ok: false, error: 'Please sign in again.' }

  const result = await changeCustomerPassword(store.siteId, session.customerId, current, next)
  if (!result.ok) return result

  // Re-issue the token so `mustChange` stops being true and the prompt goes.
  await setCustomerCookie(
    await createCustomerToken({
      siteId: store.siteId,
      customerId: session.customerId,
      name: session.name,
      mustChange: false,
    }),
  )
  revalidatePath(`/store/${token}`, 'layout')
  return { ok: true }
}
