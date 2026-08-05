import 'server-only'
import { redirect } from 'next/navigation'
import type { RowDataPacket } from 'mysql2/promise'
import { queryOne, execute } from './db'
import { verifyPassword, hashPassword } from './password'
import { defaultSiteForUser, getSiteForUser, type Site } from './sites'
import {
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  type SessionPayload,
} from './session'

/** Failed attempts before the account locks. */
const MAX_FAILED_ATTEMPTS = 5
const LOCK_MINUTES = 15

type UserRow = RowDataPacket & {
  id: number
  email: string
  password_hash: string
  full_name: string | null
  status: 'active' | 'suspended'
  must_change_password: number
  failed_attempts: number
  locked_until: Date | null
}

export type SignInResult =
  | { ok: true; siteId: number | null; mustChangePassword: boolean }
  | { ok: false; error: string }

/**
 * Verifies credentials against cp2_users and, on success, sets the session
 * cookie with the user's default site already selected.
 *
 * Bad email, bad password and suspended account all return the same message.
 * Distinguishing them would turn the login form into a way to enumerate who
 * has an account. A locked account is the one exception — the user needs to
 * know why waiting will help.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const generic = { ok: false as const, error: 'Incorrect email or password.' }

  const normalised = email.trim().toLowerCase()
  if (!normalised || !password) return generic

  const user = await queryOne<UserRow>(
    `SELECT id, email, password_hash, full_name, status, must_change_password,
            failed_attempts, locked_until
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

  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) {
    // Count the failure and lock once the threshold is crossed. Done in one
    // statement so two racing attempts can't both read the same old count.
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

  await execute(
    `UPDATE cp2_users
        SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW()
      WHERE id = ?`,
    [user.id],
  )

  // Drop them straight into their default site. A user with no site link gets
  // a null siteId and lands on a screen that says so, rather than a broken page.
  const site = await defaultSiteForUser(user.id)

  const token = await createSessionToken({
    userId: user.id,
    email: user.email,
    name: user.full_name?.trim() || user.email,
    siteId: site?.id ?? null,
    mustChangePassword: !!user.must_change_password,
  })
  await setSessionCookie(token)

  return {
    ok: true,
    siteId: site?.id ?? null,
    mustChangePassword: !!user.must_change_password,
  }
}

export async function signOut(): Promise<void> {
  await clearSessionCookie()
}

/** Minimum length for a password the user chooses themselves. */
export const MIN_PASSWORD_LENGTH = 10

export type ChangePasswordResult = { ok: true } | { ok: false; error: string }

/**
 * Replaces a user's password with one they chose and clears the
 * must_change_password flag.
 *
 * bcrypt is one-way, so this is a reset rather than a change: we never see the
 * old password and never need to. What we CAN do without asking for it is
 * compare the new password against the stored hash, which stops someone
 * "changing" a temporary password to itself and defeating the whole point.
 */
export async function changePassword(
  userId: number,
  newPassword: string,
  confirmPassword: string,
): Promise<ChangePasswordResult> {
  if (!newPassword || !confirmPassword) {
    return { ok: false, error: 'Enter your new password twice.' }
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, error: 'Those passwords do not match.' }
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    }
  }
  // bcrypt silently truncates beyond 72 bytes, so a longer password would give
  // a false sense of strength.
  if (Buffer.byteLength(newPassword, 'utf8') > 72) {
    return { ok: false, error: 'Your password must be 72 bytes or fewer.' }
  }

  const user = await queryOne<UserRow>(
    'SELECT id, password_hash, status FROM cp2_users WHERE id = ? LIMIT 1',
    [userId],
  )
  if (!user || user.status !== 'active') {
    return { ok: false, error: 'This account is no longer active.' }
  }

  if (await verifyPassword(newPassword, user.password_hash)) {
    return { ok: false, error: 'Choose a password you have not used before.' }
  }

  const hash = await hashPassword(newPassword)
  await execute(
    `UPDATE cp2_users
        SET password_hash = ?,
            must_change_password = 0,
            reset_token_hash = NULL,
            reset_expires_at = NULL,
            failed_attempts = 0,
            locked_until = NULL
      WHERE id = ?`,
    [hash, userId],
  )
  // Any outstanding reset link is invalidated at the same time — leaving one
  // live would let whoever holds it take the account straight back.

  return { ok: true }
}

/** Session or redirect to login. Use at the top of every protected page. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession()
  if (!session) redirect('/login')
  return session
}

/**
 * The site the request is acting on, re-checked against cp2_user_sites on every
 * call rather than trusted from the token. Access revoked in the control panel
 * therefore takes effect immediately instead of at the next sign-in.
 */
export async function requireSite(): Promise<Site> {
  const session = await requireSession()
  if (session.siteId === null) redirect('/select-site')

  const site = await getSiteForUser(session.userId, session.siteId)
  if (!site) redirect('/select-site')

  return site
}

export async function requireSiteId(): Promise<number> {
  return (await requireSite()).id
}

/**
 * The site and the person acting on it, for any write that leaves an audit
 * trail.
 *
 * One call rather than requireSiteId() plus a separate session read, because
 * the two must describe the same request — and because an audit row written
 * against the wrong user is worse than none. The name is snapshotted into the
 * log at write time, since cp2_users lives in another database with no foreign
 * key to protect the reference.
 */
export async function requireActor(): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
}> {
  const session = await requireSession()
  const site = await requireSite()
  return {
    siteId: site.id,
    actor: { userId: session.userId, userName: session.name },
  }
}

export { getSession }
export type { SessionPayload }
