import { NextResponse, type NextRequest } from 'next/server'
import { signIn } from '@/lib/auth'
import { clearSessionCookie } from '@/lib/session'
import { enrolDevice, isMobilePlatform } from '@/lib/control/mobileDevices'

/**
 * Enrolment: the one time the mobile app asks for a password.
 *
 * Everything after this is `/api/mobile/auth/session`, which trades the token
 * returned here for a fresh session on each cold start. The whole point is that
 * this endpoint is hit once per device and then never again.
 *
 * ── WHY IT REUSES signIn() RATHER THAN CHECKING THE PASSWORD ITSELF ─────────
 *
 * signIn() is not a password compare. It is also the lockout counter, the
 * generic-refusal rule that stops the form enumerating accounts, the sign-in
 * log, and the 2FA branch. A second implementation here would be a second
 * chance for one of those to drift — and the copy that drifts is always the one
 * guarding the door.
 *
 * The side effect is that signIn() SETS A SESSION COOKIE, which this route does
 * not want: the app takes its session from the exchange, in one place, so there
 * is only ever one path that mints one. It is cleared before responding.
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const { email, password, platform, label } = (body ?? {}) as Record<string, unknown>

  if (typeof email !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
  }
  if (!isMobilePlatform(platform)) {
    return NextResponse.json({ error: 'Unsupported platform.' }, { status: 400 })
  }

  const result = await signIn(email, password)

  if (!result.ok) {
    await clearSessionCookie()
    /* signIn()'s own message, verbatim. It is already written to be generic
       where it must be and specific where it helps (a locked account says so),
       and rewording it here would be a second policy on what a stranger learns. */
    return NextResponse.json({ error: result.error }, { status: 401 })
  }

  /* ── 2FA: REFUSED, NOT HALF-HANDLED ──────────────────────────────────────
     signIn() can come back "password proved, code next", holding a short-lived
     pending cookie the app has nowhere to put. Enrolling anyway would drop the
     second factor for the one device most likely to be left on a table — the
     same reasoning that denies offline sign-in to 2FA users in auth.ts.

     A sentence rather than a silent failure, because the user CAN act on it:
     enrol from the desktop, or turn 2FA off if that is their choice to make. */
  if ('needsTotp' in result) {
    await clearSessionCookie()
    return NextResponse.json(
      {
        error:
          'This account uses two-factor authentication, which the mobile app does not yet support. Sign in on the web instead.',
        code: 'totp_unsupported',
      },
      { status: 409 },
    )
  }

  /* A password the user has been told to change is not one to enrol a
     long-lived token against — the app has no change-password screen, so the
     device would sit on a credential the back office is actively trying to
     retire. */
  if (result.mustChangePassword) {
    await clearSessionCookie()
    return NextResponse.json(
      {
        error: 'You need to change your password before using the mobile app. Sign in on the web.',
        code: 'must_change_password',
      },
      { status: 409 },
    )
  }

  const { token } = await enrolDevice(
    /* signIn() does not return the user id, and re-reading it here would be a
       second query answering a question the session it just minted has already
       answered. Read it back off that session before clearing it. */
    await userIdFromFreshSession(),
    platform,
    typeof label === 'string' ? label : 'Mobile device',
  )

  // The session this route accidentally minted. The app gets its own from the
  // exchange below; leaving this one set would mean two ways in.
  await clearSessionCookie()

  return NextResponse.json({ token })
}

/**
 * The user id from the cookie signIn() has just set.
 *
 * Deliberately read here rather than returned from signIn(): widening that
 * function's result type would ripple through the web login form, the 2FA
 * completion and the offline path, all to serve one caller.
 */
async function userIdFromFreshSession(): Promise<number> {
  const { getSession } = await import('@/lib/session')
  const session = await getSession()
  if (!session) {
    /* signIn() returned ok and set no readable cookie. Not reachable, and if it
       ever is, enrolling a device against a guessed id is the wrong recovery. */
    throw new Error('Sign-in succeeded but no session was readable.')
  }
  return session.userId
}
