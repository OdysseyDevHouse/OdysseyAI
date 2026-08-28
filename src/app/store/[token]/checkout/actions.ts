'use server'

import { cookies, headers } from 'next/headers'
import { SHOP_SESSION_COOKIE } from '@/lib/shopSession'
import { recordEvent } from '@/lib/site/storefrontEvents'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { resolveStoreRouting, rememberedBranch, resolveStorefront } from '@/lib/storeRouting'
import { createOrderTrackToken } from '@/lib/orderTrackToken'
import { getCustomerSession } from '@/lib/customerSession'
import { createCallbackToken } from '@/lib/callbackToken'
import { buildCheckoutForm } from '@/lib/payfast/checkout'
import { createIntent, getGateway } from '@/lib/site/payments'
import { markOrderPayment } from '@/lib/site/paidOrders'
import { markOrdered } from '@/lib/site/savedBaskets'
import { validateCode } from '@/lib/site/discountCodes'
import {
  placePublicOrder,
  publishedProducts,
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
  /*
   * Routed, because delivery is one SHOP's promise to drive to one address for
   * one price. Claremont charging R35 to a suburb Wynberg charges R50 for is
   * the normal case; quoting from head office's zone list would undercharge or
   * refuse half the branches.
   */
  const routing = await resolveStoreRouting(token, await rememberedBranch(token))
  if (!routing) return { ok: false, error: 'This shop is no longer available.' }

  const context = await storefrontContext(routing.catalogueSiteId, routing.branchSiteId)
  if (!context) return { ok: false, error: 'This shop is closed at the moment.' }
  if (!context.settings.deliverEnabled) {
    return { ok: false, error: "This shop isn't delivering at the moment." }
  }

  // The total is only used to decide free-delivery and minimum thresholds, and
  // it is recomputed from the catalogue when the order is actually placed.
  const quote = await quoteDeliveryFor(
    context.siteId,
    { suburb, postcode },
    Math.max(0, Number(goodsTotal) || 0),
  )

  return {
    ok: true,
    fee: quote.fee,
    // Named, so a shopper comparing branches can see WHOSE fee this is.
    reason:
      context.branchName !== context.storeName && quote.zone
        ? `From ${context.branchName}: ${quote.reason}`
        : quote.reason,
    deliverable: quote.zone !== null && !quote.belowMinimum,
  }
}

/**
 * A tracking token, or '' when one cannot be signed.
 *
 * Never throws: this is called on the success path of an order that has
 * already been written, and failing to mint a convenience link must not turn a
 * placed order into an error the shopper sees. The confirmation page simply
 * omits the link.
 */
async function trackTokenFor(siteId: number, orderId: number): Promise<string> {
  try {
    return await createOrderTrackToken({ siteId, orderId })
  } catch {
    return ''
  }
}

/**
 * Stop chasing a shopper who has just bought the thing.
 *
 * Outside the order's transaction, and swallowing its own failures: an order
 * that succeeded must not be rolled back because a bookkeeping update on an
 * unrelated table failed. The worst case is one reminder about a basket that
 * was ordered — mildly embarrassing, where losing the order would not be.
 */
/**
 * Close the funnel, from the server's own figure.
 *
 * Reads the session key from the cookie rather than the payload, like every
 * other event: a key the caller supplies could be anyone's, and joining a
 * stranger's browsing to your purchase is worse than not joining it.
 *
 * Swallows everything. An order that succeeded must never be reported as
 * failed because a measurement row could not be written.
 */
async function recordPurchase(siteId: number, totalIncl: number): Promise<void> {
  try {
    const key = (await cookies()).get(SHOP_SESSION_COOKIE)?.value ?? ''
    if (!key) return
    await recordEvent(siteId, { kind: 'purchase', sessionKey: key, valueIncl: totalIncl })
  } catch {
    /* deliberately ignored — see above */
  }
}

async function stopChasing(siteId: number, email: string): Promise<void> {
  try {
    if (email.trim()) await markOrdered(siteId, email)
  } catch {
    /* deliberately ignored — see above */
  }
}

export type DiscountPreview =
  | { ok: true; discountIncl: number; freeDelivery: boolean; reason: string; code: string }
  | { ok: false; error: string }

/**
 * Preview a discount code against the basket.
 *
 * INDICATIVE ONLY, like the delivery quote beside it. The order is re-validated
 * and re-priced from the catalogue when it is placed, by the same validateCode
 * this calls — so a code that expires between the preview and the button, or
 * runs out of uses, is caught there and the order is refused rather than
 * silently charged full price.
 *
 * Prices come from the CATALOGUE, not the basket the browser posted: the lines
 * only supply ids and quantities, exactly as checkout does.
 */
export async function previewDiscountAction(
  token: string,
  code: string,
  lines: { productId: number; qty: number }[],
  deliveryFeeIncl: number,
): Promise<DiscountPreview> {
  /*
   * Routed, because the code is REDEEMED at the branch — validateCode runs
   * inside the branch's own transaction when the order is placed. A preview
   * resolved against head office would show a discount the branch has never
   * heard of, and refuse it at the button.
   */
  const shop = await resolveStorefront(token)
  if (!shop) return { ok: false, error: 'This shop is no longer available.' }
  const { context } = shop
  const siteId = context.siteId

  const wanted = (Array.isArray(lines) ? lines : [])
    .map((l) => ({ productId: Number(l.productId), qty: Number(l.qty) }))
    .filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0)
    .slice(0, 200)
  if (wanted.length === 0) return { ok: false, error: 'Your basket is empty.' }

  const live = await publishedProducts(context, {
    ids: wanted.map((l) => l.productId),
    limit: 200,
  })
  const byId = new Map(live.map((p) => [p.id, p]))

  const basketLines = wanted
    .filter((l) => byId.has(l.productId))
    .map((l) => {
      const product = byId.get(l.productId)!
      return {
        productId: product.id,
        qty: l.qty,
        unitPriceIncl: product.priceIncl,
        onSpecial: product.wasPriceIncl !== null,
        departmentId: product.departmentId,
      }
    })
  if (basketLines.length === 0) return { ok: false, error: 'Your basket is empty.' }

  /*
   * The signed-in shopper, read from the cookie — never from the payload, so a
   * per-customer limit cannot be dodged by naming somebody else.
   *
   * No email is passed for a GUEST preview, deliberately. The address they are
   * about to type is not known yet, and taking one from the request body would
   * let anyone check whether a stranger had already used a code. The guest's
   * limit is enforced when the order is placed, where the address is real.
   */
  const session = await getCustomerSession(siteId)

  const result = await validateCode(siteId, code, {
    lines: basketLines,
    deliveryFeeIncl: Math.max(0, Number(deliveryFeeIncl) || 0),
    customerId: session?.customerId ?? null,
  })

  if (!result.ok) return { ok: false, error: result.error }
  return {
    ok: true,
    discountIncl: result.application.discountIncl,
    freeDelivery: result.application.freeDelivery,
    reason: result.application.reason,
    code: result.application.code.code,
  }
}

export type GiftCardPreview =
  | { ok: true; code: string; display: string; balance: number }
  | { ok: false; error: string }

/**
 * Preview a gift card at checkout. Indicative like the discount preview —
 * the placing path re-reads the card and decides for itself.
 */
export async function previewGiftCardAction(
  token: string,
  code: string,
): Promise<GiftCardPreview> {
  /*
   * Routed for the same reason as the discount preview: the card is SPENT at
   * the branch, inside finaliseDocument. Previewing it against head office
   * would promise a balance the branch cannot honour.
   */
  const shop = await resolveStorefront(token)
  if (!shop) return { ok: false, error: 'This shop is no longer available.' }
  const siteId = shop.context.siteId

  const { findGiftCard, giftCardRefusal, formatGiftCardCode, normaliseGiftCardCode } =
    await import('@/lib/site/giftCards')
  const { today } = await import('@/lib/site/ledger')
  const card = await findGiftCard(siteId, code)
  const refusal = giftCardRefusal(card, code, today())
  if (refusal) return { ok: false, error: refusal }
  return {
    ok: true,
    code: normaliseGiftCardCode(code),
    display: formatGiftCardCode(normaliseGiftCardCode(code)),
    balance: card!.balance,
  }
}

export type VoucherPreview =
  | { ok: true; code: string; credit: number; label: string }
  | { ok: false; error: string }

/** Preview a loyalty voucher — signed-in shoppers only, own vouchers only. */
export async function previewVoucherAction(token: string, code: string): Promise<VoucherPreview> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return { ok: false, error: 'This shop is no longer available.' }

  const session = await getCustomerSession(siteId)
  if (!session) return { ok: false, error: 'Sign in to use your voucher.' }

  const { findVoucher } = await import('@/lib/site/loyaltyCards')
  const { memberIdForCustomer } = await import('@/lib/site/loyalty')
  const { today } = await import('@/lib/site/ledger')
  const voucher = await findVoucher(siteId, code)
  // The voucher is the member's, and the session is the customer's — so the
  // customer has to be resolved to their membership before the two can be
  // compared. No membership means no voucher of their own.
  const memberId = await memberIdForCustomer(siteId, session.customerId)
  if (!voucher || !memberId || voucher.memberId !== memberId) {
    return { ok: false, error: 'That voucher is not on your account.' }
  }
  if (voucher.status !== 'issued') return { ok: false, error: 'That voucher has already been used.' }
  if (voucher.expiresOn && voucher.expiresOn < today()) {
    return { ok: false, error: `That voucher expired on ${voucher.expiresOn}.` }
  }
  if (voucher.rewardType !== 'value') {
    return { ok: false, error: 'That voucher is for a free item — please use it at the till.' }
  }
  return { ok: true, code: voucher.code, credit: voucher.rewardValue, label: voucher.description }
}

export type PlaceResult =
  | {
      ok: true
      orderNumber: string
      total: number
      /**
       * A signed link to follow this order, minted HERE rather than derived
       * from the order number on the confirmation page.
       *
       * The done page deliberately reads nothing from the database, because an
       * order number alone is short and sequential — looking one up by number
       * would let anyone read anyone's order by counting. This token names one
       * order, is signed, and expires; it can only be produced by the request
       * that actually placed the order.
       */
      trackToken?: string
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
  /*
   * Routed, not merely verified. For a chain this resolves to TWO shops — head
   * office's catalogue and the branch that will pack the order — and the branch
   * is where every write below lands. A bare verifyPublicStoreToken here would
   * price from the right shop and bill the wrong one.
   */
  const routing = await resolveStoreRouting(token, await rememberedBranch(token))
  if (!routing) return { ok: false, error: 'This shop is no longer available.' }
  const context = await storefrontContext(routing.catalogueSiteId, routing.branchSiteId)
  if (!context) return { ok: false, error: "This store isn't taking online orders." }
  const siteId = context.siteId

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

  const result = await placePublicOrder(context, {
    ...input,
    lines,
    customerId: session?.customerId ?? null,
    // Still only a request: placePublicOrder re-checks the store setting, the
    // account's status and the credit against the total it computed itself.
    payOnAccount: input.payOnAccount === true,
  })
  if (!result.ok) return result

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
  // They bought it — any saved basket of theirs stops being one to chase.
  // Placed here rather than inside placePublicOrder's transaction so it can
  // never be the reason an order rolls back.
  await stopChasing(siteId, input.contactEmail)

  /*
   * The bottom of the funnel, recorded with the total the SERVER computed.
   *
   * Not from the browser: a basket value a shopper could set would make the
   * revenue figure worthless, and it is the one number in the report a shop
   * would actually act on. recordEvent swallows its own failures, so this
   * cannot turn a placed order into an error.
   */
  await recordPurchase(siteId, result.total)

  // The bell in the back office. After the order committed, before any branch
  // below, so every success path — gift card, on-account, pay-online,
  // gateway-down — announces exactly once. notify() swallows its own errors.
  {
    const { notify } = await import('@/lib/site/notifications')
    await notify(siteId, {
      event: 'online_order_placed',
      audience: 'online.view',
      title: `New online order ${result.orderNumber}`,
      body: `${input.contactName} — R${result.total.toFixed(2)}`,
      href: '/online-store/orders',
    })
  }

  /*
   * A gift-covered order skips the gateway entirely: the card IS the payment.
   * Invoicing runs now, in this same request. If it fails (the card drained
   * in the race window), the ORDER still stands — the established gateway-down
   * posture — with a note so staff chase it rather than a shopper losing a
   * basket they committed to.
   */
  if (result.giftCard && input.giftCardCode) {
    const { invoiceGiftCardOrder } = await import('@/lib/site/paidOrders')
    const invoiced = await invoiceGiftCardOrder(siteId, result.orderId, input.giftCardCode)
    if (!invoiced.ok) {
      const { siteExecute } = await import('@/lib/siteDb')
      await siteExecute(
        siteId,
        `UPDATE online_orders SET internal_note = CONCAT(COALESCE(internal_note,''), ?) WHERE id = ?`,
        [`\n[gift card] Payment failed after placing: ${invoiced.error}`, result.orderId],
      ).catch(() => undefined)
    }
    return {
      ok: true,
      orderNumber: result.orderNumber,
      total: result.total,
      trackToken: await trackTokenFor(siteId, result.orderId),
    }
  }

  if (result.onAccount || context?.settings.paymentMode !== 'online') {
    return {
      ok: true,
      orderNumber: result.orderNumber,
      total: result.total,
      trackToken: await trackTokenFor(siteId, result.orderId),
    }
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
      trackToken: await trackTokenFor(siteId, result.orderId),
    }
  }

  // The gateway collects the total NET of any voucher — the voucher's slice
  // settles at invoicing, where finaliseDocument spends it under the row
  // lock and records it as its own tender row.
  const amountDue = Math.round((result.total - result.voucherCredit) * 100) / 100

  const intent = await createIntent(siteId, {
    target: { purpose: 'online_order', orderId: result.orderId },
    amountIncl: amountDue,
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
    amountIncl: amountDue,
    itemName: `Order ${result.orderNumber}`,
    itemDescription: `${lines.length} item${lines.length === 1 ? '' : 's'} from ${context.storeName}`,
    // Neither of these proves payment — only the notify URL does.
    //
    // The track token rides along so someone coming back from the gateway gets
    // the same "follow your order" link as someone who paid on collection.
    // It is signed and names one order, so a URL is no more exposure than the
    // email that will carry the same link.
    returnUrl: `${origin}/store/${token}/done?order=${encodeURIComponent(result.orderNumber)}&total=${result.total}&t=${encodeURIComponent(await trackTokenFor(siteId, result.orderId))}`,
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
