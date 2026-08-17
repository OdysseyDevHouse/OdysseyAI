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
export async function createBillingCallbackToken(
  accountId: number,
  reference: string,
): Promise<string> {
  return new SignJWT({ accountId, reference })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    // No expiry. See the docblock — this is load-bearing.
    .sign(secret())
}

export async function readBillingCallbackToken(
  token: string,
): Promise<{ accountId: number; reference: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const accountId = Number(payload.accountId)
    const reference = typeof payload.reference === 'string' ? payload.reference : ''
    if (!Number.isInteger(accountId) || accountId <= 0) return null
    return { accountId, reference }
  } catch {
    return null
  }
}
