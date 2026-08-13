import { SignJWT, jwtVerify } from 'jose'

/**
 * The token in a technician's calendar subscription URL.
 *
 * ── WHY A TOKEN AND NOT A LOGIN ─────────────────────────────────────────────
 *
 * Google Calendar, Outlook and Apple Calendar all subscribe by fetching a URL on
 * a schedule, with no browser, no cookie and no way to sign in. The URL IS the
 * credential — which is exactly why it must name the person without being
 * guessable and without leaking the tenant.
 *
 * A raw `?siteId=1&userId=4` would be both: change the 4 and you are reading
 * somebody else's day, change the 1 and you are reading another business's.
 *
 * ── IT CARRIES NO EXPIRY, DELIBERATELY ──────────────────────────────────────
 *
 * Every other token in this app expires. This one cannot: a subscription is set
 * up once and then polled by a calendar service for years, and a URL that dies
 * after a day is a feature that silently stops working with nothing to tell the
 * technician why.
 *
 * The cost is stated plainly: a leaked URL exposes that person's job schedule —
 * customer names, addresses and times — until the secret is rotated. That is the
 * trade every calendar-feed product makes, and it is why the feed is READ-ONLY
 * and carries no financial data at all: no prices, no costs, no margins. The
 * worst case is somebody learning where a technician will be.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * IDENTIFICATION, never authorisation. A valid token says "this feed belongs to
 * user 4 on site 1" and nothing more. The route still reads only that user's own
 * appointments, so a token cannot widen what it can see even if it were forged.
 */

const AUDIENCE = 'ody-job-calendar'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createCalendarToken(siteId: number, userId: number): Promise<string> {
  return new SignJWT({ siteId, userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    // No .setExpirationTime — see the header. A subscription outlives any
    // sensible expiry, and a feed that stops working silently is worse than one
    // that can be revoked by rotating the secret.
    .sign(secret())
}

export async function readCalendarToken(
  token: string,
): Promise<{ siteId: number; userId: number } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    const userId = Number(payload.userId)
    if (!Number.isInteger(siteId) || siteId <= 0) return null
    if (!Number.isInteger(userId) || userId <= 0) return null
    return { siteId, userId }
  } catch {
    return null
  }
}
