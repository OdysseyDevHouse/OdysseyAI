import 'server-only'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'

/**
 * Who is standing at the till.
 *
 * SEPARATE FROM THE BACK-OFFICE SESSION on purpose. The browser session says
 * which company's data is open and is good for twelve hours; this says which
 * PERSON is ringing up the sale in front of them, and a shop floor swaps that
 * person several times a day. Folding the two together would mean either a
 * cashier signing out of the whole application at the end of their stint, or a
 * back-office login that silently attributes takings to whoever opened the
 * browser that morning.
 *
 * Short-lived for the same reason: an unattended till should stop being
 * somebody's identity long before it stops being logged in.
 */

export const TILL_COOKIE = 'odyssey_till'
const MAX_AGE_SECONDS = 60 * 60 * 8

export type TillSession = {
  userId: number
  name: string
  /** The site this was issued for. A till session must not survive a switch. */
  siteId: number
}

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET
  if (!value) throw new Error('SESSION_SECRET is not set')
  return new TextEncoder().encode(value)
}

export async function createTillToken(payload: TillSession): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret())
}

export async function setTillCookie(token: string): Promise<void> {
  const jar = await cookies()
  jar.set(TILL_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.APP_MODE !== 'desktop',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export async function clearTillCookie(): Promise<void> {
  const jar = await cookies()
  jar.delete(TILL_COOKIE)
}

/**
 * The operator at the till, or null.
 *
 * `siteId` is checked by the caller rather than trusted: a token minted for
 * one shop must not identify anyone in another, and the site can change under
 * a cookie that is still perfectly valid.
 */
export async function getTillSession(siteId: number): Promise<TillSession | null> {
  const jar = await cookies()
  const token = jar.get(TILL_COOKIE)?.value
  if (!token) return null

  try {
    const { payload } = await jwtVerify(token, secret())
    const session: TillSession = {
      userId: Number(payload.userId),
      name: String(payload.name),
      siteId: Number(payload.siteId),
    }
    return session.siteId === siteId ? session : null
  } catch {
    // Expired, tampered, or signed with a rotated secret — all mean "nobody".
    return null
  }
}
