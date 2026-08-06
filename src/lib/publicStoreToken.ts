import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The public storefront link token.
 *
 * The storefront has to know which store a visitor is shopping at, but a raw
 * siteId in a URL is an enumerable tenant identifier — change the 1 to a 2 and
 * you are looking at someone else's shop. So the link carries an opaque signed
 * token instead.
 *
 * DETERMINISTIC AND NON-EXPIRING, deliberately. The link gets printed on till
 * slips, stuck in a WhatsApp status and turned into a QR code on the door, so
 * regenerating it must always produce the same URL and a link shared last year
 * must still work. That rules out `iat`, `exp` and `jti` — any of them would
 * make the same store mint a different link on every call.
 *
 * THIS IS IDENTIFICATION, NOT AUTHORISATION. Holding the token gets a visitor
 * the storefront for that store and nothing else. What the storefront actually
 * exposes is governed by the store's own publish settings, which fail closed —
 * see `publishedProducts` in site/storefront.ts.
 */

/** Its own audience, so no other signed token in the app can be replayed here. */
const AUDIENCE = 'ody-public-store'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createPublicStoreToken(siteId: number): Promise<string> {
  return new SignJWT({ siteId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    // No iat/exp/jti — see the determinism note above.
    .sign(secret())
}

/** Resolve a storefront token back to its siteId, or null when it is invalid. */
export async function verifyPublicStoreToken(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    return Number.isInteger(siteId) && siteId > 0 ? siteId : null
  } catch {
    return null
  }
}
