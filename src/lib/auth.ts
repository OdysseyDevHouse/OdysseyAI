import 'server-only'
import { redirect } from 'next/navigation'
import type { RowDataPacket } from 'mysql2/promise'
import { queryOne, execute } from './db'
import { verifyPassword, hashPassword } from './password'
import { defaultSiteForUser, getSiteForUser, type Site } from './sites'
import { siteExecute } from './siteDb'
import { getTillSession } from './tillSession'
import { getUserByControlId, type SiteUser } from './site/users'
import {
  capabilitiesForRole,
  can,
  type Capability,
  type CapabilitySet,
} from './site/permissions'
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
  // The login page is '/', not '/login' — there is no route at the latter.
  if (!session) redirect('/')
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
 * log at write time, since there is no foreign key to protect the reference.
 *
 * The id is the SITE user's id, not the control account's. 041 gave every
 * existing control user a local row with the same id, so historic audit rows
 * still resolve; new POS-only users get ids above that range.
 *
 * THE TILL OPERATOR WINS when one is signed in. On a shared shop-floor machine
 * the browser session is whoever opened it that morning, which is exactly the
 * wrong name to put on a sale rung up by the person actually standing there.
 * Everything else — a back-office screen with no till session — is unaffected.
 */
export async function requireActor(): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
}> {
  const { site, user } = await requireSiteUser()

  const till = await getTillSession(site.id)
  if (till) {
    return { siteId: site.id, actor: { userId: till.userId, userName: till.name } }
  }

  return {
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
  }
}

/**
 * Gives a control account a local row on first sight.
 *
 * The site's first user is made an owner — a brand-new store has nobody to
 * grant permissions, so somebody has to arrive holding them. Everyone
 * afterwards arrives with NO role, because by then there IS an owner who can
 * decide, and defaulting a stranger into permissions nobody chose is how a
 * back door gets left open.
 */
async function adoptControlUser(
  siteId: number,
  controlUserId: number,
  name: string,
  email: string,
): Promise<SiteUser> {
  await siteExecute(
    siteId,
    `INSERT INTO users (name, email, control_user_id, user_type, role_id, is_active)
     SELECT ?, ?, ?, 'back_office',
            CASE WHEN (SELECT COUNT(*) FROM users u2) = 0
                 THEN (SELECT id FROM roles WHERE is_owner = 1 LIMIT 1)
                 ELSE NULL END,
            1
       FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM users u3 WHERE u3.control_user_id = ?)`,
    [name, email, controlUserId, controlUserId],
  )

  const user = await getUserByControlId(siteId, controlUserId)
  // The INSERT is guarded against duplicates, so a null here means the row was
  // created by a concurrent request and then read back — never a real absence.
  if (!user) throw new Error(`Could not create a site user for control account ${controlUserId}`)
  return user
}

/**
 * The site, the local user record, and what that user may do.
 *
 * This is the one place a request's permissions are decided, and it is
 * deliberately re-read per request rather than carried in the token: a role
 * changed on the permissions screen then takes effect on the next page load
 * rather than at the user's next sign-in.
 *
 * A control account with no local row is possible — access granted upstream
 * after the last migration ran — so one is created on sight rather than
 * turning a legitimate sign-in into an error. It lands with no role, which
 * under deny-by-default means they can reach the app and do nothing until
 * somebody gives them one.
 */
export async function requireSiteUser(): Promise<{
  site: Site
  user: SiteUser
  capabilities: CapabilitySet
}> {
  const session = await requireSession()
  const site = await requireSite()

  let user = await getUserByControlId(site.id, session.userId)
  if (!user) {
    user = await adoptControlUser(site.id, session.userId, session.name, session.email)
  }

  if (!user.isActive) redirect('/select-site?inactive=1')

  const capabilities = await capabilitiesForRole(site.id, user.roleId)
  return { site, user, capabilities }
}

/** Capabilities alone, for the many screens that need nothing else. */
export async function requireCapabilities(): Promise<CapabilitySet> {
  return (await requireSiteUser()).capabilities
}

/**
 * Blocks a page or action outright.
 *
 * For screens where a missing permission means "you should not be here at
 * all", as opposed to the ones that merely hide a button. Server actions must
 * use this rather than trusting the screen that offered them: an action is a
 * public endpoint, and the only check that counts is the one a client cannot
 * skip.
 */
export async function requireCapability(capability: Capability): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
  capabilities: CapabilitySet
}> {
  const { site, user, capabilities } = await requireSiteUser()
  if (!can(capabilities, capability)) redirect('/not-allowed')
  return {
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
    capabilities,
  }
}

/** Several, where a screen is reachable by more than one route in. */
export async function requireAnyCapability(
  ...capabilities: Capability[]
): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
  capabilities: CapabilitySet
}> {
  const ctx = await requireSiteUser()
  if (!capabilities.some((c) => can(ctx.capabilities, c))) redirect('/not-allowed')
  return {
    siteId: ctx.site.id,
    actor: { userId: ctx.user.id, userName: ctx.user.name },
    capabilities: ctx.capabilities,
  }
}

export type Denied = { ok: false; error: string }

/**
 * The server-action counterpart of `requireCapability`.
 *
 * Returns a refusal instead of redirecting, because an action is called from a
 * client that is waiting for a result — a `redirect()` mid-action surfaces as
 * an unexplained navigation rather than as the "you may not do that" the user
 * needs to read.
 *
 * Use it as the first line of EVERY mutating action:
 *
 *   const ctx = await actorFor('products.edit')
 *   if ('ok' in ctx) return ctx
 *
 * The check belongs here and not only on the screen that offered the button.
 * A server action is a public endpoint: hiding a button changes what is easy,
 * not what is possible.
 */
export async function actorFor(capability: Capability): Promise<
  | { siteId: number; actor: { userId: number; userName: string }; capabilities: CapabilitySet }
  | Denied
> {
  const { site, user, capabilities } = await requireSiteUser()
  if (!can(capabilities, capability)) {
    return {
      ok: false,
      error: 'You do not have permission to do that. An owner can grant it in Setup → Roles.',
    }
  }
  return {
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
    capabilities,
  }
}

/**
 * The API-route counterpart.
 *
 * Routes under `src/app/api` sit OUTSIDE the (app) route group, so
 * `(app)/layout.tsx` never runs for them and nothing else checks a capability
 * on their behalf. They are also directly typeable URLs — `/api/customers/
 * export` hands over the whole debtors book — which makes them the one place
 * where a missing check leaks data rather than merely allowing an action.
 *
 * Returns a site id or null; the caller answers 403 on null. Deliberately not
 * a redirect: a fetch following a 307 to an HTML page is worse to debug than a
 * plain refusal.
 */
export async function siteIdForCapability(capability: Capability): Promise<number | null> {
  const { site, capabilities } = await requireSiteUser()
  return can(capabilities, capability) ? site.id : null
}

export { getSession }
export type { SessionPayload }
