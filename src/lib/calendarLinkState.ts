import { SignJWT, jwtVerify } from 'jose'
import { isCalendarProvider, type CalendarProviderName } from './calendarModel'

/**
 * The OAuth `state` parameter, signed.
 *
 * ── WHY state IS THE CSRF DEFENCE ───────────────────────────────────────────
 *
 * OAuth hands `state` back to the callback untouched, so it is where the
 * request records what it was for. A raw `?userId=4&provider=google` would let
 * anybody who can make a victim's browser reach the callback bind THEIR
 * calendar to somebody else's user — or bind the victim's calendar to an
 * attacker's account.
 *
 * So it is a signed, short-lived token naming the site, the user and the
 * provider. Ten minutes is generous for a consent screen and short enough that
 * a captured URL is worthless by the time anybody replays it.
 *
 * Its own audience, like every other token in this app: a signature is only
 * meaningful when it also says what the token is FOR, or a calendar-feed token
 * would be accepted here.
 *
 * In lib/ rather than in the route because both routes need it, and a route
 * file that exports helpers confuses the router about what its handlers are.
 */

const AUDIENCE = 'ody-calendar-link'
const TTL = '10m'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createLinkState(
  siteId: number,
  userId: number,
  provider: CalendarProviderName,
): Promise<string> {
  return new SignJWT({ siteId, userId, provider })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(secret())
}

export async function readLinkState(
  token: string,
): Promise<{ siteId: number; userId: number; provider: CalendarProviderName } | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const provider = String(payload.provider)
    if (!isCalendarProvider(provider)) return null
    return { siteId: Number(payload.siteId), userId: Number(payload.userId), provider }
  } catch {
    return null
  }
}

/**
 * Where the provider sends the person back.
 *
 * Must match what is registered with Google and Microsoft byte for byte, which
 * is why it prefers the configured APP_URL over the request's own origin: a
 * site reached through a proxy sees an origin the provider has never heard of,
 * and the mismatch fails at the consent screen with an error naming neither.
 */
export function calendarRedirectUri(fallbackOrigin: string): string {
  const base = process.env.APP_URL?.replace(/\/$/, '') ?? fallbackOrigin
  return `${base}/api/jobs/calendar/callback`
}
