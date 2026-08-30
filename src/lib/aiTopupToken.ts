import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The token on the notify URL for an AI-credits top-up.
 *
 * ── WHY IT IS A THIRD TOKEN ────────────────────────────────────────────────
 *
 * There are now three PayFast callbacks in this codebase and they must never
 * settle each other's money:
 *
 *   callbackToken.ts        a tenant shop collecting from its shoppers
 *   billingCallbackToken.ts Odyssey collecting a subscription from a tenant
 *   this one                Odyssey collecting a once-off top-up from a tenant
 *
 * The audience is what enforces it. A token minted for one verifies to null on
 * the other two routes, so no route can resolve a payload it was not meant to
 * see — guaranteed by `jose` rather than by anybody remembering. Adding a flag
 * to the subscription token instead would have made a shopper's basket and a
 * monthly debit order one bad boolean apart.
 *
 * ── THIS ONE EXPIRES, AND THE SUBSCRIPTION ONE MUST NOT ────────────────────
 *
 * READ THIS BEFORE MAKING THEM CONSISTENT.
 *
 * billingCallbackToken.ts deliberately has no expiry, because PayFast stores a
 * subscription's notify URL and reuses it for every future collection — month
 * 2, month 14, month 30. An expiry there silently discards every renewal after
 * the first.
 *
 * A top-up is once-off. Its notify URL is used within minutes and never again,
 * so an expiry costs nothing and closes the window in which a leaked URL is
 * worth anything. The two tokens differ here because the payments differ, not
 * because one of them is an oversight.
 *
 * Seven days rather than an hour: PayFast retries a notification it did not see
 * acknowledged, and a shop that pays on Friday evening into an outage should
 * still be credited when the retries land. The token is not what makes the
 * callback safe — a valid PayFast signature, the source-IP check and PayFast's
 * own post-back all still have to pass — so a generous window costs nothing
 * that the verification does not already cover.
 */

const AUDIENCE = 'ody-ai-topup-callback'
const EXPIRY = '7d'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

/**
 * `reference` is the pending top-up's own reference, and unlike the
 * subscription token's it IS used to find the row: a once-off payment has
 * exactly one checkout behind it, so the reference identifies it for as long as
 * the token is valid.
 */
export async function createAiTopupToken(accountId: number, reference: string): Promise<string> {
  return new SignJWT({ accountId, reference })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(secret())
}

export async function readAiTopupToken(
  token: string,
): Promise<{ accountId: number; reference: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const accountId = Number(payload.accountId)
    const reference = typeof payload.reference === 'string' ? payload.reference : ''
    if (!Number.isInteger(accountId) || accountId <= 0) return null
    if (!reference) return null
    return { accountId, reference }
  } catch {
    return null
  }
}
