import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The public "book a table" link token.
 *
 * The same approach as publicStoreToken.ts — an opaque signed token instead of
 * a raw siteId, which would be an enumerable tenant identifier sitting in a URL
 * on a public website.
 *
 * ── ITS OWN AUDIENCE, AND THAT IS THE POINT ───────────────────────────────
 *
 * A separate module rather than a parameter on the storefront token, because a
 * storefront link must never be replayable as a booking link, or the reverse.
 * The audience check is what enforces that, so the two token types cannot be
 * confused even though both carry nothing but a siteId.
 *
 * ── DETERMINISTIC AND NON-EXPIRING ────────────────────────────────────────
 *
 * This link is the href behind a "Book a table" button on the restaurant's own
 * website and the QR code on the door. Regenerating it must always produce the
 * same URL, and links shared months ago must keep working — so no iat, no exp,
 * no jti.
 *
 * ── IDENTIFICATION, NOT AUTHORISATION ─────────────────────────────────────
 *
 * Holding the token gets a visitor the booking form for that shop, and nothing
 * more. Whether the form accepts anything is governed by the shop's reservation
 * settings, which fail closed.
 */

/** Its own audience, so no other signed token in the app can be replayed here. */
const AUDIENCE = 'ody-public-reserve'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createPublicReserveToken(siteId: number): Promise<string> {
  return new SignJWT({ siteId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    // No iat/exp/jti — see the determinism note above.
    .sign(secret())
}

/** Resolve a booking token back to its siteId, or null when it is invalid. */
export async function verifyPublicReserveToken(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    return Number.isInteger(siteId) && siteId > 0 ? siteId : null
  } catch {
    return null
  }
}
