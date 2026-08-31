import 'server-only'
import { buildCheckoutSignature, type CheckoutFields } from './signature'

/**
 * The form a shopper's browser posts to PayFast.
 *
 * We do not redirect through our own server or call an API: PayFast's hosted
 * checkout is a plain form POST, which means the card details never touch this
 * application at all. That is the entire reason to use a hosted gateway, and
 * it is why the fields below are safe to hand to the browser — merchant_id and
 * merchant_key are the public half of the credentials, and the signature binds
 * them to an amount we chose.
 *
 * The PASSPHRASE never leaves the server. It only ever appears inside the md5.
 */

export const PAYFAST_PROCESS_URL = {
  live: 'https://www.payfast.co.za/eng/process',
  sandbox: 'https://sandbox.payfast.co.za/eng/process',
} as const

export { PAYFAST_SANDBOX_CREDENTIALS } from './sandbox'

export type CheckoutRequest = {
  merchantId: string
  merchantKey: string
  passphrase: string
  sandbox: boolean
  /** Our opaque reference. Comes back on the callback as m_payment_id. */
  reference: string
  amountIncl: number
  itemName: string
  itemDescription?: string
  /** Where the shopper is sent afterwards. Neither proves payment. */
  returnUrl: string
  cancelUrl: string
  /** Where PayFast posts the ITN. The only thing that DOES prove payment. */
  notifyUrl: string
  buyerName?: string
  buyerEmail?: string
}

export type CheckoutForm = {
  action: string
  /** Post these as hidden inputs, in this order. */
  fields: Record<string, string>
}

/** Split a full name into PayFast's first/last fields. */
function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

export function buildCheckoutForm(request: CheckoutRequest): CheckoutForm {
  const { first, last } = splitName(request.buyerName ?? '')

  // Two decimals, always. PayFast signs the string it is given, so "100" and
  // "100.00" produce different signatures and only one of them matches what
  // the browser posts.
  const amount = request.amountIncl.toFixed(2)

  const fields: CheckoutFields = {
    merchant_id: request.merchantId,
    merchant_key: request.merchantKey,
    return_url: request.returnUrl,
    cancel_url: request.cancelUrl,
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

  const signature = buildCheckoutSignature(fields, request.passphrase)

  // Only non-empty fields are posted, matching exactly what was signed — an
  // empty field that is posted but not signed breaks verification.
  const posted: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue
    posted[key] = String(value)
  }
  posted.signature = signature

  return {
    action: request.sandbox ? PAYFAST_PROCESS_URL.sandbox : PAYFAST_PROCESS_URL.live,
    fields: posted,
  }
}
