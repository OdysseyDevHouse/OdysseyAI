import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { siteQueryOne, siteExecute } from '@/lib/siteDb'
import { deriveVerifier, verifierMatches, verifierSalt, VERIFIER_ITERATIONS } from '@/lib/offlinePin'

/**
 * Signing in to the back office when the control database cannot be reached.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Every password read in auth.ts targets cp2_users. On a cloud install that is
 * right — the control database is reached over the same network as everything
 * else, so if it is down the app has nothing to show anyway.
 *
 * A local backend is the opposite: the stock, the prices, the customers and the
 * day's takings are all on the machine in front of the user, and only the
 * password check is remote. Letting that one remote call lock a shop out of its
 * own data would make "local backend" mean nothing.
 *
 * ── THE RULE THAT MAKES IT SAFE ─────────────────────────────────────────────
 *
 * A verifier is minted ONLY after a successful ONLINE sign-in. Nothing else
 * writes one. So this can never grant access on a credential the control
 * database has not itself accepted at least once, on this machine.
 *
 * The consequence is deliberate: a user who has never signed in here cannot
 * sign in offline. A new manager on their first morning with the line down has
 * to wait, and that is the correct answer — the alternative is a machine
 * inventing its own idea of who works here.
 *
 * ── THE STALENESS WINDOW ────────────────────────────────────────────────────
 *
 * A password changed upstream while this machine was offline leaves a verifier
 * that still accepts the old one. That cannot be prevented without a network,
 * so it is BOUNDED instead: a verifier older than the lease window is refused.
 * A machine that has been offline long enough for this to matter is a machine
 * that is about to lock anyway.
 */

type Row = RowDataPacket & Record<string, unknown>

/** Wrong attempts before the account rests. */
const MAX_ATTEMPTS = 5
/** How long it rests. Long enough to make guessing pointless, short enough to survive. */
const LOCKOUT_MINUTES = 15

/**
 * How long a verifier stays usable without an online confirmation.
 *
 * Matched to the licence lease on purpose. Both answer "how long may this
 * machine act on what it was last told", and two different windows would mean a
 * machine that can sign in but not trade, or trade but not sign in — each of
 * which is a support call about the other.
 */
const MAX_AGE_DAYS = 7

export type OfflineSignInResult =
  | { ok: true; userId: number }
  | { ok: false; reason: 'no-verifier' | 'stale' | 'locked' | 'wrong' }

/**
 * Record a verifier after a successful ONLINE sign-in.
 *
 * The only path that writes one. Best-effort by construction: a user who has
 * just been authenticated upstream must not be refused because we could not
 * write down a convenience for next time.
 *
 * Called with the password in hand, which is the one moment it exists in
 * memory — it is never stored, and the verifier cannot be reversed into it.
 */
export async function rememberForOffline(
  siteId: number,
  userId: number,
  password: string,
): Promise<void> {
  const secret = process.env.OFFLINE_PIN_KEY
  if (!secret) return // not configured; offline sign-in simply stays unavailable

  try {
    const salt = await verifierSalt(secret, siteId, userId, 'backoffice')
    const verifier = await deriveVerifier(password, salt, VERIFIER_ITERATIONS)

    await siteExecute(
      siteId,
      `INSERT INTO offline_signin (user_id, verifier, iterations, confirmed_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         verifier = VALUES(verifier),
         iterations = VALUES(iterations),
         confirmed_at = NOW(),
         /* A successful online sign-in clears the offline lockout: the person
            has just proved who they are by a stronger route than the one that
            locked them out. */
         failed_attempts = 0,
         locked_until = NULL`,
      [userId, verifier, VERIFIER_ITERATIONS],
    )
  } catch {
    /* The table may not exist (a cloud site, or one mid-upgrade), or the write
       may fail. Neither is a reason to refuse a sign-in that already succeeded. */
  }
}

/**
 * Check a password against the stored verifier.
 *
 * Deliberately takes the site user id rather than an email: the caller has
 * already resolved which local user is being signed in, and re-resolving here
 * would put a second lookup — and a second chance to disagree — in the path.
 */
export async function verifyOffline(
  siteId: number,
  userId: number,
  password: string,
): Promise<OfflineSignInResult> {
  const secret = process.env.OFFLINE_PIN_KEY
  if (!secret) return { ok: false, reason: 'no-verifier' }

  let row: Row | null
  try {
    row = await siteQueryOne<Row>(
      siteId,
      `SELECT user_id, verifier, iterations, confirmed_at, failed_attempts, locked_until
         FROM offline_signin WHERE user_id = ? LIMIT 1`,
      [userId],
    )
  } catch {
    return { ok: false, reason: 'no-verifier' }
  }
  if (!row) return { ok: false, reason: 'no-verifier' }

  const now = Date.now()

  const lockedUntil = row.locked_until ? new Date(String(row.locked_until)).getTime() : 0
  if (lockedUntil > now) return { ok: false, reason: 'locked' }

  const confirmedAt = row.confirmed_at ? new Date(String(row.confirmed_at)).getTime() : 0
  if (!confirmedAt || now - confirmedAt > MAX_AGE_DAYS * 86_400_000) {
    return { ok: false, reason: 'stale' }
  }

  /* The iteration count is read from the ROW, not from the constant: a verifier
     minted before the cost was raised must keep working, or raising it would
     lock out everybody who had not signed in since. */
  const iterations = Number(row.iterations) || VERIFIER_ITERATIONS
  const salt = await verifierSalt(secret, siteId, userId, 'backoffice')
  const candidate = await deriveVerifier(password, salt, iterations)

  if (!verifierMatches(candidate, String(row.verifier))) {
    await noteFailure(siteId, userId, Number(row.failed_attempts ?? 0))
    return { ok: false, reason: 'wrong' }
  }

  /* A correct password clears the counter. Not the confirmed_at, though — that
     records the last time the CONTROL database agreed, and an offline success
     is not evidence of that. Letting it renew itself would make the staleness
     window unbounded, which is the whole thing it exists to prevent. */
  await clearFailures(siteId, userId)
  return { ok: true, userId }
}

async function noteFailure(siteId: number, userId: number, current: number): Promise<void> {
  const next = current + 1
  const lock = next >= MAX_ATTEMPTS
  try {
    await siteExecute(
      siteId,
      `UPDATE offline_signin
          SET failed_attempts = ?,
              locked_until = ${lock ? `DATE_ADD(NOW(), INTERVAL ${LOCKOUT_MINUTES} MINUTE)` : 'NULL'}
        WHERE user_id = ?`,
      /* Zeroed on lockout rather than left at the ceiling, matching the till's
         rule: the lockout IS the punishment, and the next window starts fresh
         so one bad morning does not compound into a permanent lockout. */
      [lock ? 0 : next, userId],
    )
  } catch {
    /* A lockout we could not record is worse than useless to argue about here;
       the sign-in is refused regardless, which is the part that matters. */
  }
}

async function clearFailures(siteId: number, userId: number): Promise<void> {
  try {
    await siteExecute(
      siteId,
      `UPDATE offline_signin SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?`,
      [userId],
    )
  } catch {
    /* Nothing to do. The sign-in succeeded. */
  }
}

/**
 * The local user for an email address.
 *
 * Here rather than in site/users.ts deliberately: that module's SiteUser is a
 * screen-facing shape, and the sign-in path needs three fields and no joins.
 * Keeping it local also keeps this feature out of a file several other things
 * import.
 *
 * Matched case-insensitively on a trimmed address, the same normalisation
 * signIn() applies before it queries cp2_users — otherwise a user whose email
 * was stored with a capital would be admitted online and refused offline.
 */
export type OfflineUser = {
  id: number
  name: string
  controlUserId: number | null
  isActive: boolean
}

export async function findLocalUserByEmail(
  siteId: number,
  email: string,
): Promise<OfflineUser | null> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT id, name, control_user_id, is_active
         FROM users
        WHERE LOWER(TRIM(email)) = ? AND user_type = 'back_office'
        LIMIT 1`,
      [email.trim().toLowerCase()],
    )
    if (!row) return null
    return {
      id: Number(row.id),
      name: String(row.name ?? ''),
      controlUserId: row.control_user_id ? Number(row.control_user_id) : null,
      isActive: Number(row.is_active) === 1,
    }
  } catch {
    return null
  }
}

/** For a screen that wants to say whether offline sign-in is even possible here. */
export async function hasOfflineCredential(siteId: number, userId: number): Promise<boolean> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT 1 AS present FROM offline_signin WHERE user_id = ? LIMIT 1`,
      [userId],
    )
    return Boolean(row)
  } catch {
    return false
  }
}
