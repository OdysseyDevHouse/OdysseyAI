import 'server-only'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The signed-in shopper's session.
 *
 * ── ITS OWN AUDIENCE, ITS OWN COOKIE ─────────────────────────────────────
 *
 * A staff session and a customer session are signed with the same secret, so
 * without a distinct audience a customer token would verify as a staff one and
 * hand a shopper the back office. The audience is what makes that impossible;
 * the separate cookie name means the two never overwrite each other either, so
 * a shop owner can be signed into the admin and their own storefront at once.
 *
 * ── IT CARRIES IDENTITY, NEVER ENTITLEMENT ───────────────────────────────
 *
 * The token says who this is and which store they signed in at. It does not
 * say what their credit limit is or whether their account is open — those are
 * re-read from the database on every request, so a hold staff applied this
 * morning takes effect immediately rather than whenever the shopper next signs
 * in. A token that carried the limit would be a limit the holder could keep
 * using for a week.
 *
 * ── SCOPED TO ONE STORE ──────────────────────────────────────────────────
 *
 * `siteId` is checked against the store being browsed. One browser may shop at
 * two stores on this platform, and a session minted at one must never
 * authenticate at the other — the customer ids are per-site and would
 * otherwise collide into someone else's account.
 */

const AUDIENCE = 'ody-customer'
export const CUSTOMER_COOKIE = 'odyssey_customer'

/** Long enough to shop over a few days, short enough that a lost phone expires. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14

export type CustomerSession = {
  siteId: number
  customerId: number
  /** Shown in the masthead. The full record is never put in a token. */
  name: string
  mustChange: boolean
}

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createCustomerToken(session: CustomerSession): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret())
}

export async function readCustomerToken(token: string): Promise<CustomerSession | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    const customerId = Number(payload.customerId)
    if (!Number.isInteger(siteId) || siteId <= 0) return null
    if (!Number.isInteger(customerId) || customerId <= 0) return null
    return {
      siteId,
      customerId,
      name: String(payload.name ?? ''),
      mustChange: payload.mustChange === true,
    }
  } catch {
    return null
  }
}

export async function setCustomerCookie(token: string): Promise<void> {
  const jar = await cookies()
  jar.set(CUSTOMER_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure in production only, so this still works over plain HTTP in
    // development — a cookie that never sets locally is a login that appears
    // to succeed and then does nothing.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export async function clearCustomerCookie(): Promise<void> {
  const jar = await cookies()
  jar.set(CUSTOMER_COOKIE, '', { path: '/', maxAge: 0 })
}

/**
 * The signed-in customer FOR THIS STORE, or null.
 *
 * Takes the siteId the caller is serving and refuses a session minted
 * elsewhere. Every storefront read of the session goes through here, so that
 * check cannot be forgotten at a call site.
 */
export async function getCustomerSession(siteId: number): Promise<CustomerSession | null> {
  const jar = await cookies()
  const raw = jar.get(CUSTOMER_COOKIE)?.value
  if (!raw) return null
  const session = await readCustomerToken(raw)
  if (!session) return null
  return session.siteId === siteId ? session : null
}
