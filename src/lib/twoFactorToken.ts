import 'server-only'
import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'

/**
 * The half-signed-in state: password proved, code still owed.
 *
 * Its OWN cookie, not the session cookie — proxy.ts checks only for
 * `odyssey_session`, so a visitor holding this pass is still treated as
 * signed out everywhere except the code step. Five minutes: long enough to
 * open an authenticator, short enough that an abandoned login screen is not
 * a standing invitation.
 */

const COOKIE = 'odyssey_2fa'
const AUDIENCE = 'ody-2fa-pending'
const TTL = '5m'

export async function setPendingTotpCookie(userId: number): Promise<void> {
  const token = await new SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(secret())
  const store = await cookies()
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 300,
  })
}

/** The pending user, or null when the pass is absent, foreign or expired. */
export async function getPendingTotpUser(): Promise<number | null> {
  const store = await cookies()
  const token = store.get(COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const userId = Number(payload.userId)
    return Number.isInteger(userId) && userId > 0 ? userId : null
  } catch {
    return null
  }
}

export async function clearPendingTotpCookie(): Promise<void> {
  const store = await cookies()
  store.delete(COOKIE)
}

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}
