import 'server-only'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { WINDOW_COOKIE, windowMatches } from './windowSession'

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
 *
 * ── AND SHORTER STILL THAN ITS OWN EIGHT HOURS ────────────────────────────
 *
 * Eight hours is the CEILING, not the life. The token is also bound to the tab
 * that signed in (`wid` below), so closing the window ends the session there
 * and then. A clerk who shuts the counter window and walks away has signed out,
 * whatever the clock says. See `src/lib/windowSession.ts` for why that binding
 * rests on `sessionStorage` rather than on a session cookie.
 */

export const TILL_COOKIE = 'odyssey_till'
const MAX_AGE_SECONDS = 60 * 60 * 8

export type TillSession = {
  userId: number
  name: string
  /** The site this was issued for. A till session must not survive a switch. */
  siteId: number
  /**
   * The TAB this was signed in on — see `src/lib/windowSession.ts`.
   *
   * OPTIONAL, and that carries meaning rather than being laziness, exactly as
   * `sid` does on the browser session: a token with no `wid` predates this
   * feature and is accepted, because refusing them would put every counter in
   * the country back at the PIN pad at deploy time, mid-trade. They age out
   * within eight hours by themselves.
   */
  wid?: string
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
 *
 * The TAB is checked here too, and that is the difference between "this cookie
 * is valid" and "the person who signed in is still here". A window that was
 * closed and reopened sends the cookie and not the tab id, so this answers null
 * and the caller renders the PIN pad — which is the whole point of the binding.
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
      /* MUST be mapped here, not merely added to the type — the same trap
         `readSessionToken` documents for `sid`. This rebuilds the payload field
         by field, so a claim signed into the token but missing from this list is
         silently dropped, and a dropped `wid` reads as "not bound", which means
         the check below never fires and nothing anywhere looks broken. */
      wid: typeof payload.wid === 'string' ? payload.wid : undefined,
    }
    if (session.siteId !== siteId) return null
    if (!windowMatches(session.wid, jar.get(WINDOW_COOKIE)?.value ?? null)) return null
    return session
  } catch {
    // Expired, tampered, or signed with a rotated secret — all mean "nobody".
    return null
  }
}

