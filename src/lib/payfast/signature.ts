import { createHash } from 'node:crypto'

/**
 * PayFast signature generation.
 *
 * Both algorithms produce an md5 of a `key=value&…` string; they differ in
 * which keys are included and in what order.
 *
 * THE ENCODING IS THE PART THAT BITES. PayFast signs with PHP's `urlencode()`,
 * which is NOT `encodeURIComponent()`. They differ on a handful of characters,
 * and a single mismatch makes the gateway reject an otherwise perfect request:
 *
 *   space  → `+`     (encodeURIComponent gives %20)
 *   ~ * ( ) ! '      → percent-escaped (encodeURIComponent leaves them literal)
 *
 * So we encode with encodeURIComponent and then fix up those cases. A shop
 * whose name contains an apostrophe — "Joe's Butchery" — is exactly the case
 * that fails if this is skipped.
 */

/** Faithful re-implementation of PHP's urlencode(). */
export function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

/**
 * The field order PayFast expects for a CHECKOUT signature. Fields outside
 * this list are excluded from the signature entirely; empty values are
 * skipped; the passphrase goes last.
 */
export const CHECKOUT_FIELD_ORDER = [
  'merchant_id',
  'merchant_key',
  'return_url',
  'cancel_url',
  'notify_url',
  'name_first',
  'name_last',
  'email_address',
  'cell_number',
  'm_payment_id',
  'amount',
  'item_name',
  'item_description',
  'custom_str1',
  'custom_str2',
  'custom_str3',
  'custom_str4',
  'custom_str5',
  'email_confirmation',
  'confirmation_address',
  'payment_method',
] as const

export type CheckoutFields = Partial<
  Record<(typeof CHECKOUT_FIELD_ORDER)[number], string | number>
>

/** Sign a checkout form post: documented order, skip empties, passphrase last. */
export function buildCheckoutSignature(fields: CheckoutFields, passphrase?: string): string {
  const parts: string[] = []
  for (const key of CHECKOUT_FIELD_ORDER) {
    const value = fields[key]
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}=${phpUrlEncode(String(value).trim())}`)
  }
  if (passphrase) parts.push(`passphrase=${phpUrlEncode(passphrase.trim())}`)
  return md5(parts.join('&'))
}

/**
 * Verify the signature on an ITN callback.
 *
 * PayFast signs the posted fields IN THE ORDER THEY ARRIVE — not the canonical
 * checkout order — excluding `signature` itself, with the passphrase appended.
 * That is why the caller must hand us ORDERED entries: rebuilding from a plain
 * object would reorder the keys and every signature would fail.
 */
export function verifyItnSignature(
  orderedEntries: readonly (readonly [string, string])[],
  receivedSignature: string,
  passphrase?: string,
): boolean {
  const parts: string[] = []
  for (const [key, value] of orderedEntries) {
    if (key === 'signature') continue
    if (value === '') continue
    parts.push(`${key}=${phpUrlEncode(value.trim())}`)
  }
  if (passphrase) parts.push(`passphrase=${phpUrlEncode(passphrase.trim())}`)

  return timingSafeEqualHex(md5(parts.join('&')), (receivedSignature || '').toLowerCase())
}

/**
 * Compare two hex digests without leaking, through timing, how much of the
 * prefix matched. Overkill for an md5 the sender already knows? No — the
 * attacker here does NOT know the expected value, because it depends on the
 * store's passphrase, which is precisely the secret this protects.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
