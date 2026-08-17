import 'server-only'
import { buildCheckoutSignature, type CheckoutFields } from './signature'
import { PAYFAST_PROCESS_URL, type CheckoutForm } from './checkout'
import type { PlatformPayFastConfig } from './platformConfig'

/**
 * The form that sets up a monthly debit order for a billing account.
 *
 * ── WHY THIS IS NOT A FLAG ON buildCheckoutForm ────────────────────────────
 *
 * `checkout.ts` builds a tenant shop's once-off payment — a shopper buying
 * groceries. Adding a `recurring?: boolean` to it would mean one wrong value
 * somewhere turns a shopper's R80 basket into a monthly debit order against
 * their card. Two functions cannot make that mistake.
 */

export type SubscriptionCheckoutRequest = {
  config: PlatformPayFastConfig
  /** Our m_payment_id — a fresh UUID per attempt. */
  reference: string
  /** VAT-inclusive rands. Becomes both `amount` and `recurring_amount`. */
  amountIncl: number
  /** YYYY-MM-DD — when PayFast should take the first collection. */
  billingDate: string
  itemName: string
  itemDescription?: string
  /** Carries the billing callback token, so the ITN can find the account. */
  notifyUrl: string
  buyerName?: string
  buyerEmail?: string
  /** A breadcrumb for support only — NEVER used to resolve the account. */
  accountId: number
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

/** PayFast's code for a monthly cycle. */
const FREQUENCY_MONTHLY = '3'

export function buildSubscriptionForm(request: SubscriptionCheckoutRequest): CheckoutForm {
  const { config } = request
  const { first, last } = splitName(request.buyerName ?? '')

  /* ONE string used for both amounts.
     `amount` is the first collection and `recurring_amount` every one after.
     Letting them diverge is the classic subscription bug: the customer is
     charged correctly once and then some other number for ever, and nothing
     errors because both values are individually valid. */
  const amount = request.amountIncl.toFixed(2)

  const fields: CheckoutFields = {
    merchant_id: config.merchantId,
    merchant_key: config.merchantKey,
    return_url: config.returnUrl,
    cancel_url: config.cancelUrl,
    notify_url: request.notifyUrl,
    name_first: first,
    name_last: last,
    // A malformed address is rejected outright by PayFast, so an unusable one
    // is better left out than sent.
    email_address: request.buyerEmail?.includes('@') ? request.buyerEmail : '',
    m_payment_id: request.reference,
    amount,
    item_name: request.itemName.slice(0, 100),
    item_description: (request.itemDescription ?? '').slice(0, 255),
    /* Support breadcrumb. The account is resolved from OUR signed token on the
       notify URL — anything the payload says about itself is a claim, not a
       fact, and treating this as authoritative would let a payload name its
       own account. */
    custom_int1: request.accountId,
    // subscription_type 1 = subscription. There is no "0"; PayFast rejects it,
    // which is why a once-off form omits the field entirely rather than
    // sending a zero.
    subscription_type: '1',
    billing_date: request.billingDate,
    recurring_amount: amount,
    frequency: FREQUENCY_MONTHLY,
    // 0 = until cancelled. A finite count would silently stop collecting one
    // month and nobody would notice until the account lapsed.
    cycles: '0',
  }

  const signature = buildCheckoutSignature(fields, config.passphrase)

  // Post exactly what was signed. An empty field that is posted but not signed
  // breaks verification at the gateway.
  const posted: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue
    posted[key] = String(value)
  }
  posted.signature = signature

  return {
    action: config.sandbox ? PAYFAST_PROCESS_URL.sandbox : PAYFAST_PROCESS_URL.live,
    fields: posted,
  }
}
