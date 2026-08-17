import 'server-only'
import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import type { RowDataPacket } from 'mysql2/promise'
import { queryOne, execute } from './db'
import { claimSession, sessionIsCurrent, releaseSession } from './control/sessions'
import {
  entitlementsForSite,
  has as hasModule,
  type ModuleEntitlements,
  type ModuleKey,
} from './control/modules'
import { moduleLabelFor } from './control/moduleMessages'
import { verifyPassword, hashPassword } from './password'
import { getSiteForUser, listSitesForUser, type Site } from './sites'
import { siteExecute } from './siteDb'
import { getTillSession } from './tillSession'
import { getUserByControlId, getUser, type SiteUser } from './site/users'
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

/**
 * Is one-session-per-user enforcement switched off?
 *
 * Only ever true OUTSIDE a production build, and only when asked for. Local
 * work wants several tabs open at once — a second tab, or an automated run
 * signing in while you are mid-task, mints a new session and evicts the first,
 * which makes the app unusable for exactly the person developing it.
 *
 * ── WHY TWO CONDITIONS AND NOT JUST THE FLAG ────────────────────────────────
 *
 * `NODE_ENV` is the authority; the flag only opts in. Gating on the variable
 * alone would mean a stray ALLOW_MULTIPLE_SESSIONS=1 left in a deployed .env
 * silently disables the licensing rule on the live product — the failure would
 * be invisible, because nothing looks broken when a check stops firing. Next
 * sets NODE_ENV=production for `next build`/`next start` and cannot be talked
 * out of it, so the production path cannot reach the opt-out at all.
 */
function multipleSessionsAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_MULTIPLE_SESSIONS === '1'
}

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

/** A store offered in the sign-in picker. Deliberately the bare minimum. */
export type SignInChoice = { id: number; name: string; code: string }

export type SignInResult =
  | {
      ok: true
      siteId: number | null
      mustChangePassword: boolean
      /**
       * The stores to choose between, when there is a genuine choice. Empty
       * when the account has one store (already open) or none. Name and code
       * only — the full `Site` carries the VAT number, registration number and
       * postal address, none of which belongs in a client component's props.
       */
      choices: SignInChoice[]
    }
  /** Password proved, but the account carries 2FA: the code step comes next.
      No session exists yet — only the short-lived pending cookie. */
  | { ok: true; needsTotp: true }
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

  let user: UserRow | null
  try {
    user = await queryOne<UserRow>(
      `SELECT id, email, password_hash, full_name, status, must_change_password,
              failed_attempts, locked_until
         FROM cp2_users
        WHERE email = ?
        LIMIT 1`,
      [normalised],
    )
  } catch (err) {
    /*
     * ── THE CONTROL DATABASE IS UNREACHABLE ────────────────────────────────
     *
     * On a cloud install this is fatal and should be: the app has nothing to
     * show without it, and pretending otherwise would only move the failure a
     * screen later.
     *
     * On a LOCAL backend it is the ordinary state of a shop whose line is
     * down, and everything the user came for — the stock, the prices, the
     * day's takings — is on the machine in front of them. Only the password
     * check was ever remote. Letting that one call lock them out of their own
     * data would make a local backend meaningless.
     *
     * The fallback verifies against a credential minted the last time this
     * person signed in HERE, online. It cannot invent a user, and it cannot
     * outlive the lease window. See lib/licence/offlineSignIn.ts.
     */
    const offline = await trySignInOffline(normalised, password)
    if (offline) return offline
    throw err
  }
  if (!user) {
    await recordSignInSafe({ userId: null, email: normalised, event: 'failed' })
    return generic
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await recordSignInSafe({ userId: user.id, email: normalised, event: 'locked' })
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
    await recordSignInSafe({ userId: user.id, email: normalised, event: 'failed' })
    return generic
  }

  /*
   * Two-factor (004): the password is right, but the session waits for the
   * code. Nothing here resets failed_attempts or stamps last_login_at — the
   * counters only reset in finishSignIn, or re-entering the known password
   * would let a code-guesser reset their own lock forever.
   */
  const { totpStatus } = await import('./twoFactor')
  if ((await totpStatus(user.id)).enabled) {
    const { setPendingTotpCookie } = await import('./twoFactorToken')
    await setPendingTotpCookie(user.id)
    return { ok: true, needsTotp: true }
  }

  /* The one moment the password exists in memory alongside a confirmed
     identity. On a desktop install that is when the offline credential is
     minted — see rememberForOffline, which is the ONLY writer of one and is
     what keeps offline sign-in unable to admit anybody control has not
     already accepted here. */
  const result = await finishSignIn(user, normalised)
  if (result.ok && 'siteId' in result) void rememberOfflineCredential(result.siteId, user.id, password)
  return result
}

/**
 * Mint this user's offline credential after a successful online sign-in.
 *
 * Fire-and-forget, and silent on failure: a user who has just authenticated
 * upstream must never be refused because a convenience for next time could not
 * be written. Does nothing at all off the desktop build.
 */
async function rememberOfflineCredential(
  siteId: number | null,
  controlUserId: number,
  password: string,
): Promise<void> {
  if (process.env.APP_MODE !== 'desktop' || siteId === null) return
  try {
    const { getUserByControlId } = await import('./site/users')
    const localUser = await getUserByControlId(siteId, controlUserId)
    if (!localUser) return
    const { rememberForOffline } = await import('./licence/offlineSignIn')
    await rememberForOffline(siteId, localUser.id, password)
  } catch {
    /* Nothing to do — the sign-in already succeeded. */
  }
}

/**
 * Sign in with no control database, on a local backend only.
 *
 * ── WHAT IT WILL AND WILL NOT DO ────────────────────────────────────────────
 *
 * It verifies the password against a verifier minted the last time this person
 * signed in ON THIS MACHINE, online. That is the whole of its authority. It
 * cannot invent a user, cannot admit somebody who has never signed in here, and
 * refuses a verifier older than the lease window — because a password changed
 * upstream while the machine was offline would otherwise keep working forever.
 *
 * Returns null when this is not a situation it should handle: a cloud install,
 * an unconfigured key, or a user with no local record. The caller then rethrows
 * the original database error, which is the honest outcome.
 *
 * ── WHAT IS DIFFERENT ABOUT THE SESSION IT MINTS ────────────────────────────
 *
 * No claimSession: the one-live-session registry lives in the control database,
 * so there is nothing to claim against. That is a real, deliberate reduction —
 * while a machine is offline, the same account could in principle be signed in
 * here and elsewhere. It is bounded by the same seven days as everything else,
 * and the alternative is a shop that cannot open.
 */
async function trySignInOffline(
  normalisedEmail: string,
  password: string,
): Promise<SignInResult | null> {
  if (process.env.APP_MODE !== 'desktop') return null

  try {
    const { resolveOfflineSite } = await import('./licence/offlineSite')
    const site = await resolveOfflineSite()
    if (!site) return null

    const { findLocalUserByEmail, verifyOffline } = await import('./licence/offlineSignIn')
    const localUser = await findLocalUserByEmail(site.siteId, normalisedEmail)
    /* Back-office users only — the lookup itself filters on user_type. A
       POS-only user has no business here, and their PIN is a different
       credential checked on a different screen. */
    if (!localUser || !localUser.controlUserId || !localUser.isActive) return null

    const result = await verifyOffline(site.siteId, localUser.id, password)

    if (!result.ok) {
      if (result.reason === 'locked') {
        return { ok: false, error: 'This account is temporarily locked. Try again shortly.' }
      }
      if (result.reason === 'stale') {
        return {
          ok: false,
          error:
            'This machine has been offline too long to sign in on its own. Reconnect it to the internet and try again.',
        }
      }
      /* 'wrong' and 'no-verifier' both answer generically. Saying "you have
         never signed in on this machine" would tell an attacker which accounts
         are worth attacking here. */
      return { ok: false, error: 'Incorrect email or password.' }
    }

    const sid = randomUUID()
    const token = await createSessionToken({
      userId: localUser.controlUserId,
      email: normalisedEmail,
      name: localUser.name || normalisedEmail,
      siteId: site.siteId,
      /* Never forced offline: the change-password screen writes to the control
         database, so sending them there would be sending them to a wall. */
      mustChangePassword: false,
      sid,
    })
    await setSessionCookie(token)

    return { ok: true, siteId: site.siteId, mustChangePassword: false, choices: [] }
  } catch {
    /* Anything unexpected: fall back to the caller's rethrow, so the failure is
       reported as what it is — a database that could not be reached — rather
       than as a wrong password. */
    return null
  }
}

/**
 * The tail of a successful sign-in: counters reset, session minted, cookie
 * set. Shared by the password path and the 2FA completion so the two can
 * never disagree about what "signed in" writes.
 */
async function finishSignIn(user: UserRow, normalisedEmail: string): Promise<SignInResult> {
  await execute(
    `UPDATE cp2_users
        SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW()
      WHERE id = ?`,
    [user.id],
  )
  await recordSignInSafe({ userId: user.id, email: normalisedEmail, event: 'success' })

  // One site: open it. More than one: leave the session's site null so the
  // caller sends them to /select-site to choose — picking for them would hide
  // the fact that they have access to another store's books. A user with no
  // site link also gets a null siteId, and lands on a screen that says so
  // rather than a broken page.
  const sites = await listSitesForUser(user.id)
  const siteId = sites.length === 1 ? sites[0].id : null

  /* ── ONE LIVE SESSION PER USER ───────────────────────────────────────────
     Claiming displaces whatever was there, so this sign-in ends the previous
     one wherever it was — the whole point of the feature, and the reason a
     company cannot buy one seat and share it across ten desks.

     NOT wrapped in a try/catch, unlike the sign-in log above. A swallowed
     failure here would leave the user signed in with no registry row, which
     reads as "not enrolled" and silently exempts them from enforcement. Better
     to refuse the sign-in and have somebody notice. */
  const sid = randomUUID()
  await claimSession(user.id, sid, await signInMeta())

  const token = await createSessionToken({
    userId: user.id,
    email: user.email,
    name: user.full_name?.trim() || user.email,
    siteId,
    mustChangePassword: !!user.must_change_password,
    sid,
  })
  await setSessionCookie(token)

  return {
    ok: true,
    siteId,
    mustChangePassword: !!user.must_change_password,
    choices:
      sites.length > 1
        ? sites.map((s) => ({ id: s.id, name: s.displayName, code: s.code }))
        : [],
  }
}

/**
 * The second half of a 2FA sign-in: the pending cookie names who, the code
 * proves it is them. Failures count toward the SAME lockout as passwords do
 * — a code is just another credential to guess.
 */
export async function completeTotpSignIn(code: string): Promise<SignInResult> {
  const { getPendingTotpUser, clearPendingTotpCookie } = await import('./twoFactorToken')
  const pendingUserId = await getPendingTotpUser()
  if (!pendingUserId) {
    return { ok: false, error: 'That took too long — sign in again.' }
  }

  const user = await queryOne<UserRow>(
    `SELECT id, email, password_hash, full_name, status, must_change_password,
            failed_attempts, locked_until
       FROM cp2_users WHERE id = ? LIMIT 1`,
    [pendingUserId],
  )
  if (!user || user.status !== 'active') {
    await clearPendingTotpCookie()
    return { ok: false, error: 'Sign in again.' }
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await clearPendingTotpCookie()
    return { ok: false, error: 'This account is temporarily locked. Try again shortly.' }
  }

  const { verifySignInCode } = await import('./twoFactor')
  const good = await verifySignInCode(user.id, code)
  if (!good) {
    await execute(
      `UPDATE cp2_users
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= ?
                                  THEN DATE_ADD(NOW(), INTERVAL ? MINUTE)
                                  ELSE locked_until END
        WHERE id = ?`,
      [MAX_FAILED_ATTEMPTS, LOCK_MINUTES, user.id],
    )
    await recordSignInSafe({ userId: user.id, email: user.email, event: 'totp_failed' })
    return { ok: false, error: 'That code did not match. Try the next one from the app.' }
  }

  await clearPendingTotpCookie()
  /* No offline credential is minted here, and cannot be: this half of a 2FA
     sign-in never sees the password — signIn() verified it and handed over
     before the code was entered.

     The consequence, stated plainly: a user with 2FA enabled on a desktop
     install gets no offline sign-in. That is the right way round. Their second
     factor is a live check against a secret in the control database, so
     admitting them offline would silently drop the very factor they turned on,
     and a machine that quietly downgrades somebody's security because the line
     is down is worse than one that asks them to wait. */
  return finishSignIn(user, user.email)
}

/**
 * Where this sign-in came from, for the session registry.
 *
 * Best-effort: the columns exist so support can answer "why was I signed out?"
 * with "because this account signed in from Chrome on Windows at 14:02", and a
 * missing header is not worth failing a sign-in over — unlike the registry row
 * itself, which is.
 */
async function signInMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const { headers } = await import('next/headers')
    const head = await headers().catch(() => null)
    return {
      ip: head?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: head?.get('user-agent') ?? null,
    }
  } catch {
    return { ip: null, userAgent: null }
  }
}

/** The log write, never allowed to fail a sign-in. */
async function recordSignInSafe(e: {
  userId: number | null
  email: string
  event: 'success' | 'failed' | 'locked' | 'totp_failed'
}): Promise<void> {
  try {
    const { recordSignIn } = await import('./signinLog')
    const { headers } = await import('next/headers')
    const head = await headers().catch(() => null)
    const ip = head?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    await recordSignIn({ ...e, ip })
  } catch {
    /* deliberately swallowed */
  }
}

export async function signOut(): Promise<void> {
  /* Free the seat, rather than leaving it held until the token would have
     expired twelve hours from now. Read the session BEFORE clearing the cookie,
     which is the only place the user id is available. */
  const session = await getSession()
  if (session?.sid) await releaseSession(session.userId)
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

/**
 * Session or redirect to login. Use at the top of every protected page.
 *
 * ── THE ONE CHOKEPOINT ──────────────────────────────────────────────────────
 *
 * Every guard in this file reaches here: requireSite, requireSiteUser, all the
 * capability helpers, actorFor and its variants. Three hundred-odd files import
 * one of those, and not one of them had to change for the session check below —
 * which is exactly why it belongs here rather than in each of them.
 *
 * `src/proxy.ts` deliberately does NOT do this. It checks only that a cookie is
 * present, because it runs on every asset request and verifying a JWT (let alone
 * reading a database) there would be paid for on every image the app serves.
 */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession()
  // The login page is '/', not '/login' — there is no route at the latter.
  if (!session) redirect('/')

  /* SUPERSEDED BY A NEWER SIGN-IN?
     A token with no `sid` is not enrolled and is skipped — a session minted
     before this shipped, or one minted by the till's PIN unlock. See the field's
     own comment in session.ts for why both are deliberate.

     `multipleSessionsAllowed()` short-circuits the whole check in local
     development. Note it comes FIRST: it skips the database round trip too, not
     just the redirect, so the dev path costs nothing per guarded request. */
  if (
    !multipleSessionsAllowed() &&
    session.sid &&
    !(await sessionIsCurrent(session.userId, session.sid))
  ) {
    /* NO clearSessionCookie() HERE, deliberately.
       Deleting a cookie is a WRITE, and Next forbids cookie writes during a page
       render — it throws, which surfaces as "a server error occurred" instead of
       the redirect. (Found exactly that way: the eviction fired and the page
       500'd.) Leaving the dead cookie in place costs nothing, because every
       later request re-runs this check and lands here again; the login page
       clears it, which is a context where writing is allowed. */
    redirect('/?kicked=1')
  }

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
  modules: ModuleEntitlements
}> {
  const session = await requireSession()
  const site = await requireSite()

  let user = await getUserByControlId(site.id, session.userId)
  if (!user) {
    user = await adoptControlUser(site.id, session.userId, session.name, session.email)
  }

  if (!user.isActive) redirect('/select-site?inactive=1')

  const capabilities = await capabilitiesForRole(site.id, user.roleId)
  /* What the SHOP has bought, alongside what this PERSON may do. Two different
     questions with two different answers, deliberately kept apart — see
     control/modules.ts. Memoised per request, so the several guards a single
     render reaches share one read. */
  const modules = await entitlementsForSite(site.id)
  return { site, user, capabilities, modules }
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
  modules: ModuleEntitlements
}> {
  const { site, user, capabilities, modules } = await requireSiteUser()
  if (!can(capabilities, capability)) redirect('/not-allowed')
  return {
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
    capabilities,
    modules,
  }
}

/** Several, where a screen is reachable by more than one route in. */
export async function requireAnyCapability(
  ...capabilities: Capability[]
): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
  capabilities: CapabilitySet
  modules: ModuleEntitlements
}> {
  const ctx = await requireSiteUser()
  if (!capabilities.some((c) => can(ctx.capabilities, c))) redirect('/not-allowed')
  return {
    siteId: ctx.site.id,
    actor: { userId: ctx.user.id, userName: ctx.user.name },
    capabilities: ctx.capabilities,
    modules: ctx.modules,
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
  | {
      siteId: number
      actor: { userId: number; userName: string }
      capabilities: CapabilitySet
      modules: ModuleEntitlements
    }
  | Denied
> {
  const { site, user, capabilities, modules } = await requireSiteUser()
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
    modules,
  }
}

/**
 * `actorFor`, but satisfied by ANY ONE of several capabilities.
 *
 * For a resource reached from two screens whose editors are legitimately different
 * people. The shop's picture library is the case this exists for: a front-page banner
 * is edited under `online.edit`, a department picture under `products.edit`, and
 * neither person necessarily holds the other's right. Guarding the library on one of
 * them would hand the other an empty picker and an upload that failed — which looks
 * broken rather than forbidden.
 *
 * This grants nobody anything new. Each capability already permits putting pictures on
 * the things its own screen owns; what this expresses is "may edit something pictures
 * go on", which is the actual question. A narrower AND would be wrong, not safer — it
 * would demand rights neither editor needs.
 */
export async function actorForAny(
  ...capabilities: Capability[]
): Promise<
  | {
      siteId: number
      actor: { userId: number; userName: string }
      capabilities: CapabilitySet
      modules: ModuleEntitlements
    }
  | Denied
> {
  const { site, user, capabilities: held, modules } = await requireSiteUser()
  if (!capabilities.some((capability) => can(held, capability))) {
    return {
      ok: false,
      error: 'You do not have permission to do that. An owner can grant it in Setup → Roles.',
    }
  }
  return {
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
    capabilities: held,
    modules,
  }
}

/* ── Module guards ──────────────────────────────────────────────────────────
 *
 * A module is what the SHOP bought; a capability is what the PERSON may do.
 * Both are required, and they are asked in that order everywhere below.
 *
 * The order is not cosmetic. "Your shop has not bought Loyalty" and "your role
 * does not include Loyalty" send the reader to two different people — the first
 * to whoever pays the bill, the second to whoever manages roles. Asking the
 * capability first would tell a cashier at a shop without Loyalty to go and
 * request a permission that would not help them.
 */

/**
 * A page behind a module.
 *
 * Redirects to /upgrade rather than /not-allowed, because the two mean
 * different things and lead to different fixes.
 */
export async function requireModule(module: ModuleKey): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
  capabilities: CapabilitySet
  modules: ModuleEntitlements
}> {
  const { site, user, capabilities, modules } = await requireSiteUser()
  if (!hasModule(modules, module)) redirect(`/upgrade?module=${module}`)
  return {
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
    capabilities,
    modules,
  }
}

/**
 * Both questions, in one call — the shape almost every gated page wants.
 *
 * A page guarded on only one half is the bug this exists to prevent: on the
 * module alone, a cashier reaches member balances at a shop that bought
 * Loyalty; on the capability alone, the URL works at a shop that never bought
 * it at all.
 */
export async function requireModuleCapability(
  module: ModuleKey,
  capability: Capability,
): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
  capabilities: CapabilitySet
  modules: ModuleEntitlements
}> {
  const { site, user, capabilities, modules } = await requireSiteUser()
  if (!hasModule(modules, module)) redirect(`/upgrade?module=${module}`)
  if (!can(capabilities, capability)) redirect('/not-allowed')
  return {
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
    capabilities,
    modules,
  }
}

/**
 * The server-action counterpart. Returns a refusal rather than redirecting,
 * for the same reason `actorFor` does.
 *
 * Use it as the first line of every mutating action behind a module:
 *
 *   const ctx = await actorForModule('loyalty', 'loyalty.adjust')
 *   if ('ok' in ctx) return ctx
 *
 * Hiding the screen is not enough. An action is a public endpoint, and a shop
 * that never bought Loyalty must not be able to award points by calling one.
 */
export async function actorForModule(
  module: ModuleKey,
  capability: Capability,
): Promise<
  | {
      siteId: number
      actor: { userId: number; userName: string }
      capabilities: CapabilitySet
      modules: ModuleEntitlements
    }
  | Denied
> {
  const { site, user, capabilities, modules } = await requireSiteUser()

  if (!hasModule(modules, module)) {
    return { ok: false, error: moduleLabelFor(module, can(capabilities, 'setup.edit')) }
  }
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
    modules,
  }
}

/**
 * The till operator, swapped into an `actorFor` context.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `actorFor` resolves the BROWSER session, which on a shared shop-floor machine
 * is whoever opened it that morning. `requireActor` resolves the PIN operator
 * but checks no capability. A till action needs both, and before this helper
 * every file that wanted both wrote its own version — four of them, which drifted:
 * `shiftActions.ts` and `returnActions.ts` returned the operator's identity AND
 * capabilities, while the sales file's copy returned capabilities only and threw
 * the identity away. So the till resolved the right person to decide whether a
 * discount was allowed, and then wrote the wrong person's name on the sale.
 *
 * That is not a small mistake: `sales_document_lines.sales_rep_user_id` is what
 * commission pays on, so every sale on a shared machine paid the browser user.
 *
 * ── PERMISSION VS IDENTITY ─────────────────────────────────────────────────
 *
 * Both move to the operator, deliberately. A manager signed into the back office
 * who hands the till to a junior must not leave their own rights on the screen,
 * and must not have their name on the junior's sales. The PIN decides both.
 *
 * ── WHEN THERE IS NO TILL SESSION ──────────────────────────────────────────
 *
 * The context is returned untouched. That is the back-office case, and it is
 * also the till whose 8-hour cookie has lapsed under a 12-hour browser session
 * — so this can never produce a MISSING actor, only the same one `actorFor`
 * would have given. Offline sales, where the operator is known to the client but
 * not to the server, are still attributed to the browser user; closing that
 * needs the client to be trusted with an id it is currently not.
 */
export async function withTillOperator<
  T extends { siteId: number; actor: { userId: number; userName: string }; capabilities: CapabilitySet },
>(ctx: T): Promise<T> {
  const till = await getTillSession(ctx.siteId)
  if (!till) return ctx

  const operator = await getUser(ctx.siteId, till.userId)
  /* A till session naming a user who has since been deleted. Falling back is
     right: refusing would strand a working till mid-sale over a stale cookie. */
  if (!operator) return ctx

  return {
    ...ctx,
    actor: { userId: operator.id, userName: operator.name },
    capabilities: await capabilitiesForRole(ctx.siteId, operator.roleId),
  }
}

/**
 * For actions whose return type has no room for a refusal.
 *
 * A lookup returning `TillProduct[]`, or a form action returning a state
 * object with a required `message`, cannot express "denied" in its own shape —
 * and widening every one of those signatures would push the check into every
 * caller, which is exactly where it gets forgotten.
 *
 * Throwing is right for these. They are only ever called by a screen the user
 * already had to pass a page guard to reach, so reaching one without the
 * capability means the client is doing something the UI never offered: the
 * honest answer is an error, not a plausible-looking empty list.
 */
export async function actorForOrThrow(capability: Capability): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
  capabilities: CapabilitySet
  modules: ModuleEntitlements
}> {
  const { site, user, capabilities, modules } = await requireSiteUser()
  if (!can(capabilities, capability)) {
    throw new Error(`Not allowed: ${capability}`)
  }
  return {
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
    capabilities,
    modules,
  }
}

/**
 * `actorForOrThrow`, with the module asked first.
 *
 * For the actions that throw rather than returning a refusal — the ones whose
 * caller already has a try/catch and turns a throw into a message. The module
 * is checked before the capability for the same reason it is everywhere else.
 */
export async function actorForModuleOrThrow(
  module: ModuleKey,
  capability: Capability,
): Promise<{
  siteId: number
  actor: { userId: number; userName: string }
  capabilities: CapabilitySet
  modules: ModuleEntitlements
}> {
  const { site, user, capabilities, modules } = await requireSiteUser()
  if (!hasModule(modules, module)) {
    throw new Error(moduleLabelFor(module, can(capabilities, 'setup.edit')))
  }
  if (!can(capabilities, capability)) {
    throw new Error(`Not allowed: ${capability}`)
  }
  return {
    siteId: site.id,
    actor: { userId: user.id, userName: user.name },
    capabilities,
    modules,
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

/**
 * The same check, but keeping the caller's whole capability set.
 *
 * For routes whose OUTPUT depends on more than the one permission that opened
 * them — a report export, where `reports.view` grants the file but
 * `products.cost` decides whether the margin columns are in it. Returning only
 * a site id would force the route to re-read the session to answer that, and
 * the version that "just exports everything" is exactly the leak this avoids.
 */
export async function actorForCapability(capability: Capability): Promise<{
  siteId: number
  /** The store's name, for a document that outlives the screen it came from. */
  siteName: string
  actor: { userId: number; userName: string }
  capabilities: CapabilitySet
} | null> {
  const { site, user, capabilities } = await requireSiteUser()
  if (!can(capabilities, capability)) return null
  return {
    siteId: site.id,
    siteName: site.displayName,
    actor: { userId: user.id, userName: user.name },
    capabilities,
  }
}

export { getSession }
export type { SessionPayload }
