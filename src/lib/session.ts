import 'server-only'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'

export const SESSION_COOKIE = 'odyssey_session'
const MAX_AGE_SECONDS = 60 * 60 * 12

export type SessionPayload = {
  userId: number
  email: string
  name: string
  /** The site currently open. Null when the user hasn't picked one yet. */
  siteId: number | null
  /** Set at sign-in; the app forces a password change before anything else. */
  mustChangePassword: boolean
  /**
   * Which sign-in this token belongs to — checked against `cp2_user_sessions`
   * so a newer sign-in can displace it. See `src/lib/control/sessions.ts`.
   *
   * OPTIONAL, and that carries meaning rather than being laziness: a token with
   * no `sid` is not enrolled and is never evicted. Two kinds of session are in
   * that group, both deliberately —
   *
   *   1. a token minted before this feature shipped, so a deploy does not sign
   *      the whole company out mid-afternoon;
   *   2. a session minted by the till's PIN unlock, which mints a back-office
   *      cookie from a PIN alone. Enrolling those would mean a waiter unlocking
   *      a till evicts the manager's back-office session, and a manager signing
   *      in bumps the till back to the PIN pad. Tills are licensed per DEVICE
   *      instead — see src/lib/control/devices.ts.
   */
  sid?: string
  /**
   * WHICH TABLE `userId` points at.
   *
   * Absent — the overwhelming majority — means `cp2_users.id`, in the control
   * database, which is what every caller assumed when there was only one kind
   * of sign-in. `requireSiteUser` reads it that way: it looks the person up by
   * `control_user_id`, and adopts a local row when it finds none.
   *
   * `'site'` means `users.id` in the SHOP's own database. That is the only
   * thing it can mean on a local Electron install, where sign-in is a name and
   * a PIN checked against the shop's own table and there is no control account
   * behind it at all — nothing was copied down from the cloud, and nothing is
   * written back. See docs/plans/database-setup-app.md.
   *
   * Optional rather than required, for the same reason `sid` is: a token minted
   * before this shipped keeps working, and keeps working as what it was.
   *
   * Getting this wrong is quiet rather than loud, which is why it is a field
   * and not an inference: `control_user_id` and `users.id` are both small
   * integers from different tables, so reading one as the other does not throw
   * — it returns somebody else, or adopts a person who does not exist.
   */
  scope?: 'site'
}

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET
  // Failing loudly beats silently signing with a default that would let anyone
  // forge a session.
  if (!value) throw new Error('SESSION_SECRET is not set')
  return new TextEncoder().encode(value)
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret())
}

export async function readSessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret())
    return {
      userId: Number(payload.userId),
      email: String(payload.email),
      name: String(payload.name),
      siteId: payload.siteId === null || payload.siteId === undefined ? null : Number(payload.siteId),
      mustChangePassword: !!payload.mustChangePassword,
      /* MUST be mapped here, not just added to the type.
         This function rebuilds the payload field by field, so a claim that is
         signed into the token but missing from this list is silently dropped —
         and a dropped `sid` reads as "not enrolled", which means the eviction
         check never fires and nothing anywhere looks broken. */
      sid: typeof payload.sid === 'string' ? payload.sid : undefined,
    }
  } catch {
    // Expired, tampered, or signed with a rotated secret — all mean "no session".
    return null
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.APP_MODE !== 'desktop',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
}

/** The current session, or null when signed out. */
export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null
  return readSessionToken(token)
}
