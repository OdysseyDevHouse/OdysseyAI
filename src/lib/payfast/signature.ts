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
  /* custom_int BEFORE custom_str, which is PayFast's documented order and the
     opposite of what everyone assumes. Getting it the wrong way round produces
     a perfectly well-formed md5 that the gateway rejects with nothing more
     specific than "signature mismatch". */
  'custom_int1',
  'custom_int2',
  'custom_int3',
  'custom_int4',
  'custom_int5',
  'custom_str1',
  'custom_str2',
  'custom_str3',
  'custom_str4',
  'custom_str5',
  'email_confirmation',
  'confirmation_address',
  'payment_method',
  /* ── The recurring block, last ───────────────────────────────────────────
     Only a subscription checkout sets these. `buildCheckoutSignature` skips
     anything undefined or empty, so a once-off form signs byte-identically
     whether or not these names exist in this list — which is what makes
     widening it safe for the store gateway that was here first.

     NOTE there is no `currency`. PayFast's checkout signature has no currency
     field; the merchant account fixes it. Adding the name here is harmless
     until somebody also sets a value, at which point every signature breaks. */
  'subscription_type',
  'billing_date',
  'recurring_amount',
  'frequency',
  'cycles',
  'subscription_notify_email',
  'subscription_notify_webhook',
  'subscription_notify_buyer',
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
 * Sign a call to PayFast's MANAGEMENT API — pause, cancel, change the amount.
 *
 * ── FIVE DIFFERENCES FROM THE CHECKOUT SIGNATURE, EVERY ONE A TRAP ─────────
 *
 *                     checkout                     this
 *   which keys        a fixed whitelist            every key given
 *   order             the documented order         ALPHABETICAL
 *   empty string      skipped entirely             INCLUDED
 *   whitespace        values trimmed               NOT trimmed
 *   passphrase        appended last                an ordinary sorted key
 *
 * The passphrase one costs the most time. `passphrase` sorts between
 * `merchant-id` and `timestamp`, so appending it — which is correct for a
 * checkout — yields a valid-looking digest the API rejects every single time,
 * with no hint as to why.
 *
 * The encoding is shared, and that is the point of it living beside the other
 * two rather than in the API client.
 */
export function buildApiSignature(
  payload: Record<string, string | number | undefined | null>,
  passphrase?: string,
): string {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(payload)) {
    // A signature cannot cover itself.
    if (key === 'signature') continue
    // Only absent values are dropped. An empty string is a value here, unlike
    // in the checkout signature.
    if (value === undefined || value === null) continue
    merged[key] = String(value)
  }
  if (passphrase) merged.passphrase = passphrase

  const parts = Object.keys(merged)
    .sort()
    .map((key) => `${key}=${phpUrlEncode(merged[key])}`)

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
  /*
   * ── AN EMPTY FIELD IS INCLUDED HERE, UNLIKE THE CHECKOUT SIGNATURE ──────
   *
   * The two algorithms differ on this and nothing warns you. A checkout
   * signature SKIPS empty values — we choose which fields to send, so an empty
   * one is one we left out. An ITN signature does not: PayFast posts a fixed
   * field set including every unused `custom_str1..5`, `custom_int1..5`,
   * `name_first`, `name_last` and `email_address`, and signs the lot.
   *
   * Skipping them here produced a perfectly well-formed md5 that never matched,
   * on every real callback, reported only as "signature mismatch" — so a
   * completed payment was recorded as FAILED and the customer was told nothing
   * had been charged when it had.
   *
   * VERIFIED against a real sandbox ITN: of four plausible variants, only
   * "every field as sent, then the passphrase" reproduces PayFast's own digest.
   * Do not reintroduce the skip to make this symmetrical with checkout.
   */
  const parts: string[] = []
  for (const [key, value] of orderedEntries) {
    if (key === 'signature') continue
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
