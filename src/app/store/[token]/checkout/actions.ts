'use server'

import { headers } from 'next/headers'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { getCustomerSession } from '@/lib/customerSession'
import { createCallbackToken } from '@/lib/callbackToken'
import { buildCheckoutForm } from '@/lib/payfast/checkout'
import { createIntent, getGateway } from '@/lib/site/payments'
import { markOrderPayment } from '@/lib/site/paidOrders'
import {
  placePublicOrder,
  quoteDeliveryFor,
  storefrontContext,
  type BasketLine,
  type PublicOrderInput,
} from '@/lib/site/storefront'

/**
 * Checkout, from the public internet.
 *
 * Both actions take the store TOKEN rather than a site id: the browser must
 * never be able to name which tenant it is writing to. The token is verified
 * on every call — a server action is a public HTTP endpoint, so "the layout
 * already checked it" is not a check.
 */

export type QuoteResult =
  | { ok: true; fee: number; reason: string; deliverable: boolean }
  | { ok: false; error: string }

/**
 * What delivery would cost, before the shopper commits.
 *
 * Advisory only. The fee charged is re-quoted inside `placePublicOrder` from
 * the same zones, so a stale quote in a browser tab cannot set the price.
 */
export async function quoteDeliveryAction(
  token: string,
  suburb: string,
  postcode: string,
  goodsTotal: number,
): Promise<QuoteResult> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return { ok: false, error: 'This shop is no longer available.' }

  const context = await storefrontContext(siteId)
  if (!context) return { ok: false, error: 'This shop is closed at the moment.' }
  if (!context.settings.deliverEnabled) {
    return { ok: false, error: "This shop isn't delivering at the moment." }
  }

  // The total is only used to decide free-delivery and minimum thresholds, and
  // it is recomputed from the catalogue when the order is actually placed.
  const quote = await quoteDeliveryFor(
    siteId,
    { suburb, postcode },
    Math.max(0, Number(goodsTotal) || 0),
  )

  return {
    ok: true,
    fee: quote.fee,
    reason: quote.reason,
    deliverable: quote.zone !== null && !quote.belowMinimum,
  }
}

export type PlaceResult =
  | {
      ok: true
      orderNumber: string
      total: number
      /**
       * Present when the shop takes payment online: the form the browser must
       * POST to the gateway. Absent means pay-on-collection, and the shopper
       * goes straight to the confirmation page.
       */
      payment?: { action: string; fields: Record<string, string> }
    }
  | { ok: false; error: string }

export async function placeOrderAction(
  token: string,
  input: Omit<PublicOrderInput, 'lines'> & { lines: BasketLine[] },
): Promise<PlaceResult> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return { ok: false, error: 'This shop is no longer available.' }

  // Only ids and quantities are carried across. Anything else the basket
  // claimed — a price, a description — is dropped here rather than trusted to
  // be ignored further down.
  const lines: BasketLine[] = (input.lines ?? []).map((l) => ({
    productId: Number(l.productId),
    qty: Number(l.qty),
    note: typeof l.note === 'string' ? l.note : undefined,
  }))

  /*
   * The customer comes from the SESSION COOKIE, never from the payload.
   *
   * `input` is whatever was posted, and it is spread below — so an explicit
   * customerId in it would otherwise let anyone charge any account in the shop
   * by guessing an id. Overwriting it after the spread is what makes that
   * impossible rather than merely unlikely.
   */
  const session = await getCustomerSession(siteId)

  const result = await placePublicOrder(siteId, {
    ...input,
    lines,
    customerId: session?.customerId ?? null,
    // Still only a request: placePublicOrder re-checks the store setting, the
    // account's status and the credit against the total it computed itself.
    payOnAccount: input.payOnAccount === true,
  })
  if (!result.ok) return result

  const context = await storefrontContext(siteId)

  /*
   * An account order NEVER goes to the gateway, even at a pay-online shop.
   *
   * The whole meaning of "put it on my account" is that there is nothing to
   * pay now — sending them to PayFast would ask them to settle a debt they
   * just agreed to owe. `result.onAccount` is the SERVER's decision, not the
   * checkbox, so a request that was refused still takes the payment path.
   *
   * It also means a shop with no working gateway can still take account
   * orders, which is how most of them start.
   */
  if (result.onAccount || context?.settings.paymentMode !== 'online') {
    return { ok: true, orderNumber: result.orderNumber, total: result.total }
  }

  // ── Pay online ────────────────────────────────────────────────────────
  // The intent records what we expect to be paid, BEFORE the shopper is sent
  // anywhere. The callback is checked against this figure rather than against
  // whatever the payload claims about itself.
  const gateway = await getGateway(siteId)
  if (!gateway?.isActive || !gateway.credentialsUsable) {
    // The order exists and is unpaid. Better that than losing it: the shop can
    // still phone the customer and take payment another way.
    return {
      ok: true,
      orderNumber: result.orderNumber,
      total: result.total,
    }
  }

  const intent = await createIntent(siteId, {
    targetId: result.orderId,
    amountIncl: result.total,
  })
  await markOrderPayment(siteId, result.orderId, 'pending')

  const origin = await publicOrigin()
  const callback = await createCallbackToken(siteId, intent.reference)

  const form = buildCheckoutForm({
    merchantId: gateway.merchantId,
    merchantKey: gateway.merchantKey,
    passphrase: gateway.passphrase,
    sandbox: gateway.isSandbox,
    reference: intent.reference,
    amountIncl: result.total,
    itemName: `Order ${result.orderNumber}`,
    itemDescription: `${lines.length} item${lines.length === 1 ? '' : 's'} from ${context.storeName}`,
    // Neither of these proves payment — only the notify URL does.
    returnUrl: `${origin}/store/${token}/done?order=${encodeURIComponent(result.orderNumber)}&total=${result.total}`,
    cancelUrl: `${origin}/store/${token}/checkout`,
    notifyUrl: `${origin}/api/payments/payfast/${callback}`,
    buyerName: input.contactName,
    buyerEmail: input.contactEmail,
  })

  return {
    ok: true,
    orderNumber: result.orderNumber,
    total: result.total,
    payment: form,
  }
}

/**
 * The public origin, for the URLs the gateway is given.
 *
 * Read from the incoming request's headers rather than a hardcoded value,
 * because the same build serves localhost in development and a real domain in
 * production — and a notify URL pointing at the wrong host means payments that
 * are never confirmed.
 */
async function publicOrigin(): Promise<string> {
  const head = await headers()
  const explicit = process.env.PUBLIC_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')

  const host = head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost:4100'
  const proto = head.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}
