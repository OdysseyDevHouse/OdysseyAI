import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { execute, queryOne } from '@/lib/db'

/**
 * Which back-office session is the CURRENT one for each user.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The session is a stateless JWT: signed, self-contained, twelve hours, with no
 * record that it was ever issued. That makes it fast and makes it impossible to
 * revoke — signing in on a second machine minted a second valid token and the
 * first kept working until it expired. Ten people could share one login and the
 * product had no way to notice, let alone object.
 *
 * This is the missing half. One row per user names the session that counts;
 * `requireSession` turns anything else into a trip back to the login screen.
 *
 * ── ONE ROW PER USER IS THE RULE, NOT A CONVENTION ─────────────────────────
 *
 * `user_id` is the primary key, so claiming a session is a single
 * INSERT ... ON DUPLICATE KEY UPDATE that atomically replaces whatever was
 * there. Eviction needs no DELETE, and two simultaneous sign-ins cannot race
 * into two live rows — the database decides which one won.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * Make this session the current one, displacing whatever came before.
 *
 * Deliberately NOT fail-soft. `recordSignIn` swallows its errors because a
 * missing log line is cosmetic, but a missing row here silently disables
 * enforcement for that user — which is the whole feature quietly not working.
 * A throw here fails the sign-in, which is loud and recoverable.
 */
export async function claimSession(
  userId: number,
  sessionId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  await execute(
    `INSERT INTO cp2_user_sessions (user_id, session_id, issued_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, NOW(), NOW(), ?, ?)
     ON DUPLICATE KEY UPDATE
       session_id   = VALUES(session_id),
       issued_at    = NOW(),
       last_seen_at = NOW(),
       ip           = VALUES(ip),
       user_agent   = VALUES(user_agent)`,
    [userId, sessionId, meta.ip?.slice(0, 45) ?? null, meta.userAgent?.slice(0, 255) ?? null],
  )
}

/**
 * Is this the session that counts?
 *
 * ── THE HOT PATH ────────────────────────────────────────────────────────────
 *
 * Runs on every guarded request — every page load, every server action, every
 * API route. One primary-key lookup, which is about as cheap as a query gets.
 *
 * ── WHY AN UNREADABLE REGISTRY LETS THE REQUEST THROUGH ────────────────────
 *
 * If the control database is unreachable this cannot answer, and the honest
 * options are "sign everybody out" or "let them work". It lets them work.
 *
 * Signing an entire company out of their back office because a database
 * connection blipped is a far worse failure than a few minutes of unenforced
 * session sharing — and it would happen to every user at once, mid-task, with
 * no way for them to fix it. Same trade `requireLicensedDevice` makes for the
 * till, and made explicit in both places rather than left to a caller's
 * try/catch.
 */
export async function sessionIsCurrent(userId: number, sessionId: string): Promise<boolean> {
  try {
    const row = await queryOne<Row>(
      'SELECT session_id, last_seen_at FROM cp2_user_sessions WHERE user_id = ? LIMIT 1',
      [userId],
    )

    /* NO ROW AT ALL means this user has never signed in since the feature
       shipped — an in-flight session from before the deploy. Allowed, for the
       same reason the token's `sid` is optional: nobody should be signed out by
       a deployment. The next sign-in enrols them. */
    if (!row) return true

    if (String(row.session_id) !== sessionId) return false

    void touch(userId, row.last_seen_at as Date | null)
    return true
  } catch (err) {
    console.error('[session] registry unreadable; allowing the request', err)
    return true
  }
}

/**
 * Record that the session is alive — at most once a minute.
 *
 * A single page load fires several server actions in parallel and each one runs
 * the check, so an unconditional write would turn one page view into a dozen
 * updates of the same row, queueing on each other's locks. The column only
 * exists to answer "when was this last used", where a minute's resolution is
 * ample.
 */
const TOUCH_EVERY_MS = 60_000

async function touch(userId: number, lastSeen: Date | null): Promise<void> {
  try {
    if (lastSeen && Date.now() - lastSeen.getTime() < TOUCH_EVERY_MS) return
    await execute('UPDATE cp2_user_sessions SET last_seen_at = NOW() WHERE user_id = ?', [userId])
  } catch {
    // A heartbeat is never worth failing a request over.
  }
}

/**
 * Give the seat back.
 *
 * Called on a deliberate sign-out, so the licence is freed immediately rather
 * than held until the token would have expired twelve hours later.
 */
export async function releaseSession(userId: number): Promise<void> {
  try {
    await execute('DELETE FROM cp2_user_sessions WHERE user_id = ?', [userId])
  } catch (err) {
    // The cookie is cleared regardless, so the user IS signed out on this
    // machine; the row expires from relevance at the next sign-in anyway.
    console.error('[session] could not release the session row', err)
  }
}
