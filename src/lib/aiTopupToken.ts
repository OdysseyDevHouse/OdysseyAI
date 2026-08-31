import 'server-only'
import { createHmac, timingSafeEqual } from 'crypto'

/**
 * The token on the notify URL for an AI-credits top-up.
 *
 * ── WHY IT IS NOT A JWT ────────────────────────────────────────────────────
 *
 * READ THIS BEFORE MAKING IT MATCH billingCallbackToken.ts.
 *
 * It was one, and PayFast silently refused every notification.
 *
 * `notify_url` is limited to 255 characters. A JWT carrying an account id, a
 * reference, an issued-at and an expiry runs to about 240 characters on its
 * own, and the URL it hangs off is another 74 — so the field arrived over
 * length and was DROPPED. PayFast then fell back to the merchant dashboard's
 * own notify URL, which points nowhere near a developer's tunnel, and the
 * callback simply never happened. No error at either end: the payment
 * succeeded, the shop was charged, the wallet stayed empty.
 *
 * So this carries no claims at all. It is an HMAC of the reference — 43
 * characters — and the reference itself arrives in the payload as
 * `m_payment_id`, which is where the route reads it from. The account is then
 * looked up from the pending row rather than asserted by the URL, which is
 * strictly better: a value read from our own database cannot be forged by
 * whoever holds the link.
 *
 * ── WHAT IT STILL PROVES ───────────────────────────────────────────────────
 *
 * Exactly what the JWT proved, minus the claims:
 *
 *   · WE minted this URL. The HMAC is over SESSION_SECRET, so a stranger
 *     cannot construct one for a reference they guessed.
 *   · It is for THIS route. The audience string is inside the HMAC input, so a
 *     subscription token cannot verify here and this cannot verify there —
 *     the same separation the JWT audience gave, by the same secret.
 *
 * It is not what makes the callback safe on its own. A valid PayFast
 * signature, the source-IP check, PayFast's own post-back, and the amount
 * check against the row all still have to pass before anything is written.
 *
 * ── AND WHY IT NO LONGER EXPIRES ───────────────────────────────────────────
 *
 * With no claims there is nothing to timestamp. That loses little: a top-up
 * reference is single-use, so a replayed URL settles nothing a retry would not
 * have settled anyway, and the pending row's own status guard is what actually
 * stops a second credit. billingCallbackToken.ts explains at length why ITS
 * token must never expire; this one simply has no reason to.
 */

const AUDIENCE = 'ody-ai-topup-callback'

function secret(): string {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return raw
}

/** base64url, so the value is safe in a path segment without escaping. */
function sign(reference: string): string {
  return createHmac('sha256', secret())
    .update(`${AUDIENCE}:${reference}`, 'utf8')
    .digest('base64url')
}

/**
 * The token to put on the notify URL, for the checkout named by `reference`.
 *
 * 43 characters. The reference is NOT included — it comes back on its own as
 * `m_payment_id`, and duplicating it here would only lengthen the field that
 * broke this in the first place.
 */
export function createAiTopupToken(reference: string): string {
  return sign(reference)
}

/**
 * Did we mint this token for this reference?
 *
 * The reference comes from the PAYLOAD, so the caller must read it there and
 * pass it in — which is the point: the URL alone names nothing, and a token
 * lifted from one checkout cannot vouch for another.
 */
export function verifyAiTopupToken(token: string, reference: string): boolean {
  const expected = sign(reference)
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  // Length first: timingSafeEqual throws on a mismatch rather than returning
  // false, and a wrong-length token is exactly what an attacker probes with.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
