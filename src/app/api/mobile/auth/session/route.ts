import { NextResponse, type NextRequest } from 'next/server'
import { createSessionToken, setSessionCookie } from '@/lib/session'
import { userForToken } from '@/lib/control/mobileDevices'
import { listSitesForUser } from '@/lib/sites'
import { queryOne } from '@/lib/db'
import type { RowDataPacket } from 'mysql2'

/**
 * The exchange: a refresh token in, a fresh session cookie out.
 *
 * Called on every cold start, and again whenever a request comes back 401 —
 * which it eventually will, because the session is twelve hours and a manager
 * may keep the app open across a shift. That recovery path is not an edge case
 * to bolt on later; it is the normal way this app stays signed in, and on iOS
 * it carries extra weight because WKWebView's cookie store is not something to
 * rely on surviving a restart.
 *
 * ── EVERY CHECK IS RE-DONE HERE, ON PURPOSE ─────────────────────────────────
 *
 * The token proves possession of an enrolled device and NOTHING else. Whether
 * the user still exists, is still active, and still has access to a site are
 * all re-read from the control database on each call. So access revoked in the
 * back office takes effect on the next app launch, without anyone having to
 * remember to revoke the phone as well.
 *
 * ── THE SESSION IS MINTED WITH NO `sid` ─────────────────────────────────────
 *
 * Deliberately, and it is the reason the phone does not sign the manager out of
 * their desk. A token with no `sid` is not enrolled in `cp2_user_sessions` and
 * so is never evicted by a later sign-in — the same exit the till's PIN unlock
 * takes, for the same reason, documented on the field in src/lib/session.ts.
 *
 * The revocation story is not lost by that, it is just held elsewhere: the
 * device row is the kill switch, and revoking it stops the next exchange. What
 * it cannot do is kill a session already minted, which lives at most twelve
 * hours. That is the trade, and it is the same one the till makes.
 */

type Row = RowDataPacket & Record<string, unknown>

export async function POST(req: NextRequest) {
  /* Bearer, because this is a credential and belongs in the Authorization
     header — not a cookie the WebView might later replay, and not a query
     string that would end up in an access log. */
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  const refused = NextResponse.json({ error: 'Not signed in.' }, { status: 401 })

  if (!token) return refused

  const userId = await userForToken(token)
  if (userId === null) return refused

  /* The user themselves, re-read. A suspended or deleted account holds a
     perfectly valid token and must still be turned away. */
  const user = await queryOne<Row>(
    `SELECT id, email, full_name, status, must_change_password
       FROM cp2_users
      WHERE id = ?
      LIMIT 1`,
    [userId],
  )
  if (!user || String(user.status) !== 'active') return refused

  /* Same refusal as a bad token, deliberately: a device whose owner has been
     told to change their password should stop working, and saying WHY to an
     unauthenticated caller tells a stranger which tokens name real accounts. */
  if (Number(user.must_change_password) === 1) return refused

  const sites = await listSitesForUser(userId)
  if (sites.length === 0) {
    /* Distinguishable from a bad token, because this one the holder can act on:
       they are who they say they are and simply have no store to open. */
    return NextResponse.json(
      { error: 'Your account has no store to open.', code: 'no_sites' },
      { status: 403 },
    )
  }

  /* Which store to open. The app may name one — a multi-store manager choosing
     a branch — but it is validated against the user's real access rather than
     believed, so a tampered id opens nothing. An unrecognised id falls back to
     the default rather than erroring: the picker is a convenience, and refusing
     to open ANY store because a stale id was remembered is the worse failure. */
  let requestedSiteId: number | null = null
  try {
    const body = (await req.json()) as Record<string, unknown> | null
    const raw = body?.siteId
    if (typeof raw === 'number' && Number.isInteger(raw)) requestedSiteId = raw
  } catch {
    /* No body is the normal case on a cold start. */
  }

  const site = sites.find((s) => s.id === requestedSiteId) ?? sites[0]

  await setSessionCookie(
    await createSessionToken({
      userId,
      email: String(user.email),
      name: String(user.full_name ?? '').trim() || String(user.email),
      siteId: site.id,
      /* Checked above; a `true` here never reaches this line. */
      mustChangePassword: false,
      /* No `sid` — see the note at the top of this file. */
    }),
  )

  /* The cookie is what actually authenticates the WebView. This body is for the
     native shell: which store is open, and what else this person could switch
     to, so the drawer can offer the choice without a second round trip. */
  return NextResponse.json({
    site: { id: site.id, name: site.displayName, code: site.code },
    sites: sites.map((s) => ({ id: s.id, name: s.displayName, code: s.code })),
    user: { name: String(user.full_name ?? '').trim() || String(user.email) },
  })
}
