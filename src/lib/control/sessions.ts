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
 *
 * ── WHY THE ROW STAYS IN THE CONTROL DATABASE ───────────────────────────────
 *
 * The obvious optimisation, once the control database lives on its own server
 * and the trading databases are spread across several others, is to move this
 * table into each store's own database so the check never leaves the machine
 * serving the request. It does not work, for the same reason store groups do
 * not (see lib/storeGroups.ts): a session belongs to the USER, and one user
 * reaches several stores — which land on different servers.
 *
 * Per-store rows would mean a group manager signed into two branches at once
 * holds two live sessions on one licence with nothing able to notice;
 * site-switching would leave the previous store's row still naming the old id;
 * and a password change would need a fan-out write across servers with no
 * transaction spanning them. Sign-in cannot write a store row at all —
 * `finishSignIn` claims while `siteId` is still null for exactly those
 * multi-site users.
 *
 * The cost that motivates the idea is real, and it is paid for below instead.
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
  /* Whatever this process last verified is now the wrong answer.
     This matters for the browser doing the signing IN, not the one being
     evicted: without it, a request arriving on THIS process moments later could
     be told its own predecessor is still the current session. Other processes
     hold their own copy and expire it on the interval below — see the note
     there on what that window costs. */
  verified.delete(userId)
}

/* ── THE VERIFY CACHE ────────────────────────────────────────────────────────
 *
 * `sessionIsCurrent` runs on every guarded request, and with the control
 * database on its own server that is a cross-server round trip per page load,
 * per server action, for every store on every site server. The query itself is
 * trivial — a primary-key hit on a table small enough to live permanently in
 * the buffer pool — but the trip is not, and it is paid on the one machine
 * every tenant shares.
 *
 * So a session verified in the last minute is taken at its word. This is a
 * staleness check rather than a poll: nothing runs on a timer, an idle session
 * costs nothing at all, and someone clicking through forty pages in a minute
 * pays for one lookup instead of forty.
 *
 * ── ONLY THE POSITIVE ANSWER IS CACHED ─────────────────────────────────────
 *
 * A mismatch is never remembered. The lookup that finds one has just read the
 * authoritative row, so eviction stays exact and immediate — the expensive
 * direction to get wrong is the one that never takes a shortcut. Nor is a
 * failed lookup cached: the fail-soft branch already lets that request through,
 * and remembering it would stretch one blip into a minute of unenforced access.
 *
 * ── WHAT THIS COSTS ────────────────────────────────────────────────────────
 *
 * Eviction lands within a minute instead of on the very next request, and each
 * app server holds its own copy, so a displaced browser may keep working
 * against one of them after another has already cut it off.
 *
 * That is the right trade for what this feature IS. It is a licence limit, not
 * a security boundary — it exists so ten people cannot share one seat, and an
 * extra minute of overlap does not undermine that. A revoked or deactivated
 * USER is a different question and is NOT answered here: `requireSiteUser`
 * re-reads the account on every request and is not cached.
 *
 * A minute is also the resolution the table already worked at, since
 * `last_seen_at` is only stamped that often — and skipping the read skips the
 * stamp with it, so that column behaves exactly as it did before.
 */
const VERIFY_EVERY_MS = 60_000

type Verified = { sid: string; at: number }

/* Survives module reloads in dev the same way the pools do. */
const globalVerified = globalThis as unknown as {
  __odysseySessionVerified?: Map<number, Verified>
}
const verified = (globalVerified.__odysseySessionVerified ??= new Map())

/**
 * Is this the session that counts?
 *
 * ── THE HOT PATH ────────────────────────────────────────────────────────────
 *
 * Runs on every guarded request — every page load, every server action, every
 * API route. At most one primary-key lookup per session per minute; see the
 * cache above for why, and for what that costs.
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
  /* Verified recently, and for THIS session id. Comparing the id matters as
     much as the age: the entry records WHICH session was blessed, so a token
     presenting a different one falls through to a real lookup instead of
     inheriting its predecessor's answer.

     `at` is deliberately not refreshed on a hit. Doing so would turn the
     interval into a sliding window that an active user renews forever — and an
     active user is precisely the one this exists to re-check. */
  const seen = verified.get(userId)
  if (seen && seen.sid === sessionId && Date.now() - seen.at < VERIFY_EVERY_MS) return true

  try {
    const row = await queryOne<Row>(
      'SELECT session_id, last_seen_at FROM cp2_user_sessions WHERE user_id = ? LIMIT 1',
      [userId],
    )

    /* NO ROW AT ALL means this user has never signed in since the feature
       shipped — an in-flight session from before the deploy. Allowed, for the
       same reason the token's `sid` is optional: nobody should be signed out by
       a deployment. The next sign-in enrols them. */
    if (!row) {
      remember(userId, sessionId)
      return true
    }

    /* Superseded. NOT remembered — see "only the positive answer is cached". */
    if (String(row.session_id) !== sessionId) return false

    remember(userId, sessionId)
    void touch(userId, row.last_seen_at as Date | null)
    return true
  } catch (err) {
    console.error('[session] registry unreadable; allowing the request', err)
    return true
  }
}

function remember(userId: number, sessionId: string): void {
  verified.set(userId, { sid: sessionId, at: Date.now() })
  /* One entry per signed-in user is a few dozen bytes and largely
     self-limiting, but a long-lived process should not grow a map unboundedly
     on any input. Trimmed oldest-first, well above any plausible concurrent
     user count — the same bound rateLimit.ts puts on its buckets, and just as
     harmless to overshoot: a dropped entry costs one extra lookup, nothing
     more. */
  if (verified.size > 10_000) {
    const oldest = [...verified.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [k] of oldest.slice(0, 5_000)) verified.delete(k)
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
  /* Before the delete, so a throw below cannot leave this process still holding
     a verdict for a row that is on its way out. */
  verified.delete(userId)
  try {
    await execute('DELETE FROM cp2_user_sessions WHERE user_id = ?', [userId])
  } catch (err) {
    // The cookie is cleared regardless, so the user IS signed out on this
    // machine; the row expires from relevance at the next sign-in anyway.
    console.error('[session] could not release the session row', err)
  }
}
