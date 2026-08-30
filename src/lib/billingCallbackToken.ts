import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The token on the notify URL for a PLATFORM subscription.
 *
 * ── WHY IT IS NOT callbackToken.ts ─────────────────────────────────────────
 *
 * That one names a SITE and a payment intent, for a tenant shop collecting
 * from its shoppers. This one names a BILLING ACCOUNT, for Odyssey collecting
 * from its tenants. Different audience, different claim shape, different
 * route, different PayFast merchant.
 *
 * The audience is what enforces it: a store token handed to the billing route
 * verifies to null, and a billing token handed to the store route verifies to
 * null. Neither can resolve the other's payload, and that is guaranteed by
 * `jose` rather than by anybody remembering.
 *
 * ── IT DELIBERATELY DOES NOT EXPIRE ────────────────────────────────────────
 *
 * READ THIS BEFORE ADDING setExpirationTime().
 *
 * A once-off payment settles within minutes, so a 24-hour token is free
 * safety. A SUBSCRIPTION's notify URL is stored by PayFast and used for every
 * future collection — month 2, month 14, month 30. An expiry means every
 * renewal after the first is silently discarded: the customer's card keeps
 * being debited, the payment never reaches this system, and the account lapses
 * with no error anywhere. That is the quietest way this feature could lose
 * money, and "tokens should expire" is exactly the well-meant change that
 * would cause it.
 *
 * What the token has to be, instead of short-lived:
 *
 *   - Unguessable. HS256 over SESSION_SECRET, same as every other signed token
 *     here.
 *   - Useless on its own. Holding it lets somebody POST a payload that must
 *     still carry a valid PayFast signature, survive the source-IP check, and
 *     be confirmed by PayFast's own post-back before anything is written.
 *   - Checked against live state. The account id is looked up on every call;
 *     an account that no longer exists resolves to nothing.
 */

const AUDIENCE = 'ody-billing-callback'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

/**
 * `reference` is the checkout attempt's m_payment_id, kept for support: it
 * says which attempt minted this URL. It is NOT used to match a payment —
 * PayFast reuses the notify URL across collections, so by month three the
 * reference is historical.
 */
/**
 * ── EVERY BYTE HERE IS SPENT AGAINST A 255-CHARACTER LIMIT ─────────────────
 *
 * READ THIS BEFORE ADDING A CLAIM.
 *
 * PayFast caps `notify_url` at 255 characters and DROPS the field when it is
 * longer — silently, falling back to whatever the merchant dashboard holds.
 * The symptom is the worst kind: the payment succeeds, the customer is
 * charged, and the callback never arrives, with no error at either end.
 *
 * This token carried `accountId`, `reference` and an `iat`, which came to 215
 * characters and put the URL at 291 — over the limit on any host name longer
 * than a short domain. It now carries the account and nothing else: 113
 * characters.
 *
 * `reference` is gone because nothing read it. The route resolves the
 * subscription from the ACCOUNT (subscriptionForAccount), and by month three
 * the reference names a checkout attempt that is historical anyway — the
 * docblock above already said as much. `iat` is gone because there is no
 * expiry to measure it against.
 *
 * The claim is `a`, not `accountId`, for the same reason: eight characters of
 * JSON, twice over in the base64, on a budget this tight.
 */
export async function createBillingCallbackToken(accountId: number): Promise<string> {
  return new SignJWT({ a: accountId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    // No expiry. See the docblock — this is load-bearing.
    .sign(secret())
}

export async function readBillingCallbackToken(
  token: string,
): Promise<{ accountId: number } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const accountId = Number(payload.a)
    if (!Number.isInteger(accountId) || accountId <= 0) return null
    return { accountId }
  } catch {
    return null
  }
}
