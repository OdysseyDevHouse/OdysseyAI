import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The token that tells a payment callback WHICH STORE it belongs to.
 *
 * ── THE PROBLEM IT SOLVES ────────────────────────────────────────────────
 *
 * Verifying a PayFast callback needs that store's passphrase. So the store has
 * to be known BEFORE verification can run — which means the store cannot be
 * established BY verifying. Something in the request must name it first, and
 * whatever names it must not be forgeable into pointing at a different store,
 * and must not leak the tenant id.
 *
 * ── WHY NOT A RAW siteId IN THE URL ──────────────────────────────────────
 *
 * It is an enumerable tenant identifier: change the 1 to a 2 and you are
 * aiming a payment callback at someone else's shop.
 *
 * ── WHY NOT THE REFERENCE ALONE ──────────────────────────────────────────
 *
 * Intents live in each store's OWN database. With only a reference we would
 * have to search every store's database to find the callback's owner —
 * unbounded work, driven by an unauthenticated request, which is a denial of
 * service waiting to happen.
 *
 * ── SO ───────────────────────────────────────────────────────────────────
 *
 * The notify URL carries an opaque token binding siteId AND reference
 * together, minted when the intent is created. Binding both is what matters: a
 * token for store A cannot be replayed against store B's payment, because the
 * reference inside it would not match that store's row.
 *
 * This is IDENTIFICATION, NEVER AUTHORISATION. A valid token gets a callback
 * as far as "which store, which intent". The payload must still pass the full
 * signature, source-IP, post-back, merchant and amount checks before a cent is
 * considered received.
 */

const AUDIENCE = 'ody-payment-callback'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createCallbackToken(siteId: number, reference: string): Promise<string> {
  return new SignJWT({ siteId, reference })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    // A payment attempt that has not been settled within a day is dead. The
    // gateway retries for far less than that, so this costs nothing real while
    // closing the window on a leaked notify URL.
    .setExpirationTime('24h')
    .sign(secret())
}

export async function readCallbackToken(
  token: string,
): Promise<{ siteId: number; reference: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    const reference = typeof payload.reference === 'string' ? payload.reference : ''
    if (!Number.isInteger(siteId) || siteId <= 0 || !reference) return null
    return { siteId, reference }
  } catch {
    return null
  }
}
