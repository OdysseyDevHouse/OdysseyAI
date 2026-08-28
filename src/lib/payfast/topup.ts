import type { PlatformPayFastConfig } from './platformConfig'
import { PAYFAST_PROCESS_URL, type CheckoutForm } from './checkout'
import { buildCheckoutSignature, type CheckoutFields } from './signature'

/**
 * A once-off AI-credits top-up, charged on the PLATFORM's credentials.
 *
 * ── WHY A THIRD BUILDER AND NOT A FLAG ON EITHER OF THE OTHER TWO ──────────
 *
 * There are two builders already and each is wrong for this in one specific
 * way:
 *
 *   checkout.ts       once-off, correct shape — but takes a TENANT shop's
 *                     merchant credentials, because it exists for a shop
 *                     collecting from its own shoppers.
 *   subscription.ts   platform credentials, correct payer — but recurring, and
 *                     it sends subscription_type, billing_date, frequency and
 *                     cycles, none of which belong on a single charge.
 *
 * So this is once-off like the first and platform-paid like the second.
 *
 * subscription.ts explains at its own head why it is not a `recurring?: boolean`
 * on checkout.ts: one wrong value turns a shopper's R80 basket into a monthly
 * debit order. The same argument applies with the same force here, in the other
 * direction — a flag that accidentally reads true would turn a shop's one-time
 * R500 top-up into a R500 monthly debit order against the platform's merchant
 * account. Three small builders that cannot be confused beat one with two
 * booleans.
 *
 * ── NO subscription_type FIELD AT ALL ──────────────────────────────────────
 *
 * PayFast accepts "1" (subscription) and "2" (tokenisation). There is no "0"
 * for a once-off — sending one is rejected outright. A plain charge is what you
 * get by omitting the field, which is why it does not appear below and must not
 * be added.
 */

export type TopupCheckoutRequest = {
  config: PlatformPayFastConfig
  /** Our reference on the pending top-up. Comes back as m_payment_id. */
  reference: string
  /** What to charge, in the account's currency. */
  amount: number
  itemName: string
  itemDescription?: string
  /** Carries the top-up callback token, so the ITN can find the pending row. */
  notifyUrl: string
  buyerName?: string
  buyerEmail?: string
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

export function buildTopupForm(request: TopupCheckoutRequest): CheckoutForm {
  const { first, last } = splitName(request.buyerName ?? '')
  const { config } = request

  // Two decimals, always. PayFast signs the string it is given, so "500" and
  // "500.00" produce different signatures and only one matches what is posted.
  const amount = request.amount.toFixed(2)

  const fields: CheckoutFields = {
    merchant_id: config.merchantId,
    merchant_key: config.merchantKey,
    return_url: config.returnUrl,
    cancel_url: config.cancelUrl,
    notify_url: request.notifyUrl,
    name_first: first,
    name_last: last,
    // PayFast rejects a malformed address outright, so an unusable one is
    // better omitted than sent.
    email_address: request.buyerEmail?.includes('@') ? request.buyerEmail : '',
    m_payment_id: request.reference,
    amount,
    item_name: request.itemName.slice(0, 100),
    item_description: (request.itemDescription ?? '').slice(0, 255),
  }

  const signature = buildCheckoutSignature(fields, config.passphrase)

  // Only non-empty fields are posted, matching exactly what was signed — an
  // empty field that is posted but not signed breaks verification.
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
