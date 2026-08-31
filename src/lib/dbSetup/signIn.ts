import 'server-only'
import { queryOne, execute } from '../db'
import { verifyPassword } from '../password'

/**
 * Proving who a technician is, with no browser in the picture.
 *
 * ── WHY NOT lib/auth.signIn ───────────────────────────────────────────────
 *
 * That one sets a session cookie, which means it needs a Next request context.
 * OdysseyAI Database Setup is a console program run before any of this shop's
 * software exists; there is no request, no cookie jar, and nothing to keep a
 * session for. It authenticates once, reads two rows, and exits.
 *
 * What it deliberately KEEPS from signIn: the same table, the same bcrypt
 * verifier, the same lockout, and the same refusal to say which half of the
 * credentials was wrong. A second front door with weaker rules is worth more to
 * an attacker than the first door is.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * No 2FA step. That is not an oversight to fix later — it is why this path is
 * limited to reading a site's database record, and why the account still has to
 * pass the same lockout. A technician with 2FA on their account can still use
 * this; the second factor is not checked, so the door must stay narrow.
 *
 * No offline fallback either. The whole purpose is to read the control panel;
 * a machine that cannot reach it has nothing to provision FROM.
 */

const MAX_FAILED_ATTEMPTS = 5
const LOCK_MINUTES = 15

type UserRow = {
  id: number
  email: string
  password_hash: string
  full_name: string | null
  status: string
  failed_attempts: number
  locked_until: Date | string | null
}

export type SetupSignIn =
  | { ok: true; userId: number; email: string; fullName: string | null }
  | { ok: false; error: string }

/**
 * Verify an email and password against cp2_users.
 *
 * Bad email, bad password and a suspended account all return the same message,
 * for the same reason the login form does: distinguishing them turns this into
 * a way to find out who has an account. A locked account is the exception,
 * because the person needs to know that waiting will help.
 */
export async function signInForSetup(email: string, password: string): Promise<SetupSignIn> {
  const generic = { ok: false as const, error: 'Incorrect email or password.' }

  const normalised = email.trim().toLowerCase()
  if (!normalised || !password) return generic

  const user = await queryOne<UserRow>(
    `SELECT id, email, password_hash, full_name, status, failed_attempts, locked_until
       FROM cp2_users
      WHERE email = ?
      LIMIT 1`,
    [normalised],
  )

  if (!user) return generic

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { ok: false, error: 'This account is temporarily locked. Try again shortly.' }
  }

  if (user.status !== 'active') return generic

  if (!(await verifyPassword(password, user.password_hash))) {
    /* One statement, so two racing attempts cannot both read the same old
       count — the same reason lib/auth.ts writes it this way. */
    await execute(
      `UPDATE cp2_users
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= ?
                                  THEN DATE_ADD(NOW(), INTERVAL ? MINUTE)
                                  ELSE locked_until END
        WHERE id = ?`,
      [MAX_FAILED_ATTEMPTS, LOCK_MINUTES, user.id],
    )
    return generic
  }

  await execute('UPDATE cp2_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [
    user.id,
  ])

  return { ok: true, userId: user.id, email: user.email, fullName: user.full_name }
}
