'use server'

import { revalidatePath } from 'next/cache'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { headers } from 'next/headers'
import {
  changeCustomerPassword,
  createPasswordReset,
  resetPasswordWithToken,
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

/* ── Forgot / reset password (150) ────────────────────────────────────────── */

async function publicOrigin(): Promise<string> {
  const head = await headers()
  const explicit = process.env.PUBLIC_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const host = head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost:4100'
  const proto = head.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

/**
 * "Forgot your password" — always answers the same way whether or not the
 * address matched, the anti-enumeration rule. The one honest exception is a
 * shop with no mail configured, where offering the form would be a lie.
 */
export async function requestPasswordResetAction(
  token: string,
  email: string,
): Promise<SaveResult> {
  const store = await storeFor(token)
  if (!store || !store.context.settings.allowAccount) {
    return { ok: false, error: 'This shop is not available.' }
  }

  const { isConfigured, send } = await import('@/lib/mail')
  if (!isConfigured()) {
    return {
      ok: false,
      error: 'This shop cannot send reset emails — please contact them to reset your password.',
    }
  }

  const reset = await createPasswordReset(store.siteId, email)
  if (reset) {
    const link = `${await publicOrigin()}/store/${token}/account/reset/${reset.token}`
    await send({
      to: reset.loginEmail,
      subject: 'Reset your password',
      text: `Someone asked to reset the password for your account.\n\nReset it here (the link works once, for an hour):\n${link}\n\nIf this was not you, ignore this email — nothing has changed.`,
      html: `<p>Someone asked to reset the password for your account.</p><p><a href="${link}">Reset your password</a> — the link works once, for an hour.</p><p>If this was not you, ignore this email — nothing has changed.</p>`,
    }).catch(() => undefined)
  }
  // The same answer whether it matched or not.
  return { ok: true }
}

export async function resetPasswordAction(
  token: string,
  resetToken: string,
  password: string,
): Promise<SaveResult> {
  const store = await storeFor(token)
  if (!store) return { ok: false, error: 'This shop is not available.' }
  return resetPasswordWithToken(store.siteId, resetToken, password)
}

/* ── Pay an invoice (item 37) ─────────────────────────────────────────────── */

/**
 * Mints a pay link for ONE of the shopper's own open invoices. Ownership is
 * checked against the SESSION, never the payload; settlement rides the same
 * debtor_invoice rails as an emailed pay link.
 */
export async function payInvoiceAction(
  token: string,
  transactionId: number,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const store = await storeFor(token)
  if (!store) return { ok: false, error: 'This shop is not available.' }
  const session = await getCustomerSession(store.siteId)
  if (!session) return { ok: false, error: 'Please sign in again.' }

  const { getTransaction } = await import('@/lib/site/customerLedger')
  const line = await getTransaction(store.siteId, transactionId)
  if (!line || line.customerId !== session.customerId) {
    return { ok: false, error: 'That invoice is not on your account.' }
  }
  if (line.docType !== 'invoice' || line.amountOutstanding <= 0.005) {
    return { ok: false, error: 'There is nothing left to pay on that invoice.' }
  }
  if (!line.sourceDocId || line.source !== 'sale') {
    return { ok: false, error: 'That invoice cannot be paid online — please contact the shop.' }
  }

  const { mintPaymentLink } = await import('@/lib/site/invoiceEmail')
  const url = await mintPaymentLink(
    store.siteId,
    line.sourceDocId,
    line.amountOutstanding,
    await publicOrigin(),
  )
  if (!url) {
    return { ok: false, error: 'Online payment is not available — please contact the shop.' }
  }
  return { ok: true, url }
}
