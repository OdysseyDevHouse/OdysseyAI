import 'server-only'
import { redirect } from 'next/navigation'
import { createSessionToken, setSessionCookie } from './session'
import { signInWithPin } from './site/users'

/**
 * Signing in on a shop's own machine, with no control panel in the picture.
 *
 * ── WHY THIS IS NOT auth.signIn, AND NOT trySignInOffline EITHER ────────────
 *
 * `auth.signIn` verifies against `cp2_users` in the control database. A local
 * install has no business asking it anything: the shop's staff were created on
 * this machine and were never written upstream, so there is no account there to
 * find. See docs/plans/database-setup-app.md for why the model settled that way.
 *
 * `trySignInOffline` looks closer than it is. It exists for a CLOUD site whose
 * line has dropped: it needs a `control_user_id`, a verifier seeded by an
 * earlier successful ONLINE sign-in, and it stops working after seven days.
 * Every one of those is wrong here. A local site has never been online in that
 * sense, has no upstream account, and must still open on day eight.
 *
 * ── THE CREDENTIAL IS A NAME AND A PIN ──────────────────────────────────────
 *
 * Not an email and a password, because the shop's `users` table has never
 * carried one — `041_users_roles.sql` says so outright: *"Not the credential:
 * the password lives upstream and is verified there."* On this machine there is
 * no upstream, and rather than invent a second credential the till already has
 * a working one.
 *
 * A name is not unique and does not need to be. PIN uniqueness across active
 * users IS already enforced, in `users.ts`, precisely because the till
 * identifies a person by PIN alone — so the pair resolves even when two people
 * are called Bob. The PIN finds the person; the name confirms it is who they
 * meant.
 *
 * ── NO LOCKOUT, DELIBERATELY ────────────────────────────────────────────────
 *
 * `cp2_users` counts failed attempts and locks for fifteen minutes. This does
 * not, and the shop's `users` table has no columns for it. This is a back
 * office in a shop's own office, on a machine only the people who work there
 * can physically reach — the door is the rate limiter, and a lockout would
 * mostly mean staff locked out of their own tills on a busy morning. Recorded
 * so it reads as a decision rather than an oversight.
 */

export type LocalSignInResult = { ok: true } | { ok: false; error: string }

/**
 * Is this install one that signs in against its own database?
 *
 * ── WHY NOT resolveOfflineSite ──────────────────────────────────────────────
 *
 * It looks like the same question and is not. That function answers "may this
 * machine trade on its own right now", and it earns the answer by reading
 * `licence_lease` — a row carrying licence status, entitlements and an expiry,
 * written when the machine last checked in with the control panel.
 *
 * A freshly provisioned shop has never checked in, so that table is empty. Ask
 * it which sign-in form to draw and it says "no site", the login screen falls
 * back to the CLOUD email form, and the shop owner signs in against cp2_users
 * and lands on somebody's default site — a different shop entirely. Which is
 * exactly what happened.
 *
 * The right question here is narrower: did OdysseyAI Database Setup give this
 * machine a database of its own? That is what the adopted connection means, and
 * it is a stronger claim than an environment variable on its own — those values
 * are not typed by anybody, they are unsealed from a DPAPI-sealed config that
 * only this install could have written, describing a database Setup had just
 * finished creating.
 *
 * Both are required. `ODYSSEY_SITE_ID` alone is also set by the older
 * self-provisioning backend, which has no local users table to sign anybody in
 * against; the database NAME is set only by the adopted branch.
 */
export async function localSiteId(): Promise<number | null> {
  if (process.env.APP_MODE !== 'desktop') return null
  if (!process.env.ODYSSEY_SITE_DB_NAME?.trim()) return null

  const raw = Number(process.env.ODYSSEY_SITE_ID)
  if (!Number.isFinite(raw) || raw <= 0) return null
  return raw
}

/**
 * Verify a name and PIN against the shop's own users, and mint a session.
 *
 * Everything that fails answers with one message. Which half was wrong is
 * exactly what an attacker standing at the keyboard would like to know, and
 * the shop's own staff do not need telling — they know their name.
 */
export async function signInLocal(name: string, pin: string): Promise<LocalSignInResult> {
  const generic = { ok: false as const, error: 'That name and PIN were not recognised.' }

  const siteId = await localSiteId()
  /* Not a user-facing failure so much as a machine that was never set up. Say
     so plainly: the person standing here can act on it, where "not recognised"
     would send them hunting for a typo that is not there. */
  if (siteId === null) {
    return {
      ok: false,
      error: 'This machine has not been set up for a shop yet. Run OdysseyAI Database Setup first.',
    }
  }

  const typed = name.trim()
  if (!typed || !pin) return generic

  /* The PIN identifies; the name confirms. Reusing signInWithPin rather than
     writing a second comparison loop keeps one answer to "does this PIN belong
     to anybody", including its constant-time-ish walk over every active hash
     and its last_login_at write. */
  const result = await signInWithPin(siteId, pin)
  if (!result.ok) return generic
  const user = result.user

  /* Case-insensitive, trimmed: this is typed at a keyboard by somebody who
     already knows the PIN, and rejecting "bob" for "Bob" would be a support
     call rather than a defence. */
  if (user.name.trim().toLowerCase() !== typed.toLowerCase()) return generic

  /* A till operator's PIN must not open the back office. That separation is the
     whole point of user_type, and it is checked HERE rather than by capability
     because a POS-only person should never get a back-office session at all —
     not one that then finds every screen refused. */
  if (user.userType !== 'back_office') {
    return { ok: false, error: `${user.name} is not set up for the back office.` }
  }

  await setSessionCookie(
    await createSessionToken({
      /* The SITE users table's own id — see SessionPayload.scope, which is what
         stops requireSiteUser reading this as a control account. */
      userId: user.id,
      scope: 'site',
      email: user.email ?? '',
      name: user.name,
      /* Known at sign-in and never null on a local install: this machine is one
         shop, and it was told which at provisioning. There is nothing to pick,
         so the site picker is never reached. */
      siteId,
      /* No forced change: there is no password to change. The credential is a
         PIN, managed on the shop's own Users screen like every other PIN. */
      mustChangePassword: false,
      /* No `sid`, deliberately, and for the same reason the till's PIN unlock
         omits it — the one-live-session registry lives in the control database,
         which this install does not consult. Enrolling a session there that
         nothing can evict would be a claim we cannot honour. */
    }),
  )

  return { ok: true }
}

/** Sign in and go, for the form action that has nothing else to do. */
export async function signInLocalAndRedirect(name: string, pin: string): Promise<LocalSignInResult> {
  const result = await signInLocal(name, pin)
  if (!result.ok) return result
  redirect('/')
}
