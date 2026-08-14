import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The public "request a job" link token.
 *
 * The same shape as publicReserveToken.ts, and a separate module for the reason
 * that file gives: a booking link must never be replayable as a job-request
 * link, or the reverse. The audience check is what enforces that, even though
 * both carry nothing but a siteId.
 *
 * ── DETERMINISTIC AND NON-EXPIRING ─────────────────────────────────────────
 *
 * This is the href behind a "Request a callout" button on the business's own
 * website, and printed on a van. Regenerating it must always produce the same
 * URL, and a link shared months ago must keep working — so no iat, no exp.
 *
 * ── IDENTIFICATION, NOT AUTHORISATION ──────────────────────────────────────
 *
 * Holding this gets a visitor the form for that business and nothing else. It
 * reads nothing, and what it can write is one inert row that becomes a job only
 * when somebody in the business accepts it. Whether the form accepts anything at
 * all is governed by the intake settings, which fail closed.
 */

/** Its own audience, so no other signed token in the app can be replayed here. */
const AUDIENCE = 'ody-public-intake'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createPublicIntakeToken(siteId: number): Promise<string> {
  return new SignJWT({ siteId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .sign(secret())
}

/** The site this link belongs to, or null for every kind of failure. */
export async function verifyPublicIntakeToken(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    if (!Number.isInteger(siteId) || siteId <= 0) return null
    return siteId
  } catch {
    return null
  }
}
