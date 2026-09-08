import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute, transaction } from './db'
import { hashPassword } from './password'
import { portalConfig } from './control/portalApi'
import * as portal from './control/usersPortal'

/**
 * Back-office accounts in the control database.
 *
 * These are the rows that let someone LOG IN and be pointed at a store. What
 * they may then do is decided by the site database (see site/permissions.ts) —
 * `cp2_user_sites.site_role` is a starting point copied into the local user on
 * first sight, not the authority.
 *
 * WRITING HERE IS A CROSS-DATABASE WRITE. odyssey_tickets is shared with the
 * v2 backend, which owns these tables. Inserting users and site links is what
 * the CP2 UI itself does, so it is within the contract; ALTERING the tables is
 * not, and nothing here does.
 *
 * `created_by` and `updated_by` are deliberately left NULL: they carry foreign
 * keys to `users` — v2's own admin-staff table, a different thing from
 * cp2_users — and a store has no id in it to write.
 *
 * ── EVERY FUNCTION HERE ASKS THE PORTAL FIRST ───────────────────────────────
 *
 * A desktop build has no control-database socket to open — `pool()` refuses,
 * loudly, so a missing route shows up in testing rather than as a silent
 * degradation at a counter. This file had no route, so Users and permissions
 * did not degrade on such a machine: it threw, and the screen died.
 *
 * So each function below asks control/usersPortal.ts first and keeps its query
 * as the fallback for everything the portal cannot answer — a cloud install, a
 * dev checkout, a machine with no key. Same shape as devices.ts and
 * control/modules.ts, and for the same reason: the transport moved, the rules
 * did not.
 */

/** Back-office passwords are set by an administrator, so this is the floor. */
export const MIN_CONTROL_PASSWORD = 10

export type SiteGrant = {
  siteId: number
  siteCode: string
  displayName: string
  role: 'owner' | 'manager' | 'staff'
  isDefault: boolean
  granted: boolean
}

/**
 * The control account id behind an email address, or null when there is none.
 *
 * ── WHY AN ID RATHER THAN THE ACCOUNT ───────────────────────────────────────
 *
 * This used to be findControlAccountByEmail and returned the whole row, of
 * which its one caller used `id` and nothing else. The narrowing is what let it
 * cross the portal: a site key belongs to a shop's machine, and a route that
 * named the holder of any address on the platform would turn every shop into a
 * directory of every other shop's staff. An id is meaningless without a
 * granter-scoped provision call behind it.
 *
 * The question it answers is "does this address already have a login", asked so
 * that saving GRANTS that account this store instead of creating a second one
 * and colliding on the unique index. See saveUserAction.
 */
export async function controlAccountIdForEmail(email: string): Promise<number | null> {
  /* `undefined` from the portal means it could not be asked — not "no such
     account". Getting those two the wrong way round would create a duplicate
     login for somebody who already has one, so only a real answer short-cuts
     the query below. */
  const viaPortal = await portal.controlAccountIdForEmail(email)
  if (viaPortal !== undefined) return viaPortal

  const row = await queryOne<RowDataPacket & {
    id: number
    email: string
    full_name: string | null
    status: 'active' | 'suspended'
    must_change_password: number
    last_login_at: string | null
  }>(
    `SELECT id, email, full_name, status, must_change_password, last_login_at
       FROM cp2_users WHERE email = ? LIMIT 1`,
    [email.trim().toLowerCase()],
  )
  return row ? row.id : null
}

/**
 * Every site the CURRENT user may administer, with whether the target user
 * already has access.
 *
 * Scoped to the granter's own sites on purpose: this screen lives inside one
 * store, and someone administering it has no business handing out access to a
 * store they cannot open themselves.
 */
export async function siteGrantsFor(
  granterUserId: number,
  targetControlUserId: number | null,
): Promise<SiteGrant[]> {
  const viaPortal = await portal.siteGrantsFor(granterUserId, targetControlUserId)
  if (viaPortal) return viaPortal

  const rows = await query<RowDataPacket & {
    site_id: number
    site_code: string
    company_name: string
    trading_name: string | null
    role: 'owner' | 'manager' | 'staff' | null
    is_default: number | null
  }>(
    `SELECT s.id AS site_id, s.site_code, s.company_name, s.trading_name,
            t.site_role AS role, t.is_default
       FROM cp2_user_sites g
       INNER JOIN cp2_sites s ON s.id = g.site_id
       LEFT JOIN cp2_user_sites t
              ON t.site_id = s.id AND t.user_id = ? AND t.status = 'active'
      WHERE g.user_id = ?
        AND g.status = 'active'
        AND s.status IN ('active','suspended')
      ORDER BY s.company_name ASC`,
    [targetControlUserId ?? 0, granterUserId],
  )
  return rows.map((r) => ({
    siteId: r.site_id,
    siteCode: r.site_code,
    displayName: r.trading_name?.trim() || r.company_name,
    role: r.role ?? 'staff',
    isDefault: !!r.is_default,
    granted: r.role !== null,
  }))
}

/** What one person may already open, as the edit form needs to show it. */
export type UserSiteAccess = {
  siteIds: number[]
  role: 'owner' | 'manager' | 'staff'
  defaultSiteId: number | null
}

/**
 * The store access these accounts ACTUALLY hold.
 *
 * The Users screen used to open its edit form without this and guessed — every
 * store the administrator could reach, pre-ticked. Saving then wrote that guess
 * back through `provisionControlAccount`, so editing somebody's PIN handed them
 * every branch, and their control-panel role was reset to staff on the way past.
 * A form that can overwrite a grant has to be shown the grant.
 *
 * Read for the whole list in one query rather than per row: a store has tens of
 * users and the alternative is tens of round trips to a remote database to
 * render one table.
 *
 * Scoped to the GRANTER's stores, exactly like `siteGrantsFor` and like the
 * suspend clause in `provisionControlAccount`. A store this administrator
 * cannot see stays invisible here and untouched on save.
 */
export async function accessForControlUsers(
  granterUserId: number,
  controlUserIds: number[],
): Promise<Record<number, UserSiteAccess>> {
  const out: Record<number, UserSiteAccess> = {}
  if (!granterUserId || !controlUserIds.length) return out

  const viaPortal = await portal.accessForControlUsers(granterUserId, controlUserIds)
  if (viaPortal) return viaPortal

  const rows = await query<RowDataPacket & {
    user_id: number
    site_id: number
    site_role: 'owner' | 'manager' | 'staff'
    is_default: number
  }>(
    `SELECT t.user_id, t.site_id, t.site_role, t.is_default
       FROM cp2_user_sites t
       INNER JOIN cp2_user_sites g
               ON g.site_id = t.site_id AND g.user_id = ? AND g.status = 'active'
      WHERE t.status = 'active'
        AND t.user_id IN (${controlUserIds.map(() => '?').join(',')})
      ORDER BY t.is_default DESC, t.site_id ASC`,
    [granterUserId, ...controlUserIds],
  )

  for (const r of rows) {
    // ORDER BY puts the default first, so the first row seen for a person is
    // the one whose role and site the form should open on.
    const entry = out[r.user_id] ?? { siteIds: [], role: r.site_role, defaultSiteId: null }
    entry.siteIds.push(r.site_id)
    if (r.is_default) entry.defaultSiteId = r.site_id
    out[r.user_id] = entry
  }
  return out
}

/**
 * Everybody the control panel says may open this store.
 *
 * The other half of the drift: `cp2_user_sites` is written by the control panel
 * — a different application — so a store's own Users screen only learns about a
 * new login when that person happens to sign in here. See site/userSync.ts.
 */
export async function accountsWithAccessTo(
  siteId: number,
): Promise<{ id: number; email: string; fullName: string }[]> {
  /* Answered for the SIGNING site, so the portal is only the right answer when
     this machine's key is for the site being asked about. Anywhere else — a
     cloud back office reconciling another store — the query below is. */
  if (portalConfig()?.siteId === siteId) {
    const viaPortal = await portal.accountsWithAccessTo()
    if (viaPortal) return viaPortal
  }

  const rows = await query<RowDataPacket & {
    id: number
    email: string
    full_name: string | null
  }>(
    `SELECT u.id, u.email, u.full_name
       FROM cp2_user_sites g
       INNER JOIN cp2_users u ON u.id = g.user_id
      WHERE g.site_id = ? AND g.status = 'active' AND u.status = 'active'
      ORDER BY u.id ASC`,
    [siteId],
  )
  return rows.map((r) => ({ id: r.id, email: r.email, fullName: r.full_name?.trim() || r.email }))
}

export type ProvisionResult =
  | { ok: true; controlUserId: number; adopted: boolean }
  | { ok: false; error: string }

export type ProvisionInput = {
  email: string
  fullName: string
  /** Null when updating an existing account and leaving the password alone. */
  password: string | null
  siteIds: number[]
  /** Which of `siteIds` this person opens by default. */
  defaultSiteId: number | null
  role: 'owner' | 'manager' | 'staff'
  isActive: boolean
  /**
   * `existingId` was found by EMAIL, not by a link this store already held.
   *
   * ── WHY THAT CHANGES WHAT MAY BE WRITTEN ──────────────────────────────────
   *
   * A control account can span stores, so the address typed into "add a user"
   * may belong to somebody who works for a different shop entirely. Without
   * this flag the save took that account over: it renamed it and, because the
   * form asks for a password when adding, reset the password of an account the
   * administrator has never met — after which they could sign in as them.
   *
   * So an account reached this way is only ever GRANTED this store. Its name,
   * status and password stay as their owner set them.
   */
  claimedByEmail?: boolean
}

function validate(input: ProvisionInput, isNew: boolean): string | null {
  const email = input.email.trim().toLowerCase()
  if (!email) return 'Enter an email address.'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'That email address does not look right.'
  if (!input.fullName.trim()) return 'Enter a name.'
  if (!input.siteIds.length) return 'Choose at least one store this person may open.'

  if (input.claimedByEmail && input.password !== null) {
    return 'That email address already has a back office account. Leave the password blank to give them access to this store — an existing account’s password can only be changed by the person who holds it.'
  }

  if (isNew || input.password !== null) {
    const pw = input.password ?? ''
    if (pw.length < MIN_CONTROL_PASSWORD) {
      return `The password must be at least ${MIN_CONTROL_PASSWORD} characters.`
    }
    // bcrypt silently truncates past 72 bytes, so anything longer gives a false
    // sense of strength.
    if (Buffer.byteLength(pw, 'utf8') > 72) return 'That password is too long (72 bytes maximum).'
  }
  return null
}

/**
 * Creates or updates a back-office account and its store access.
 *
 * The account and its grants go in one transaction so a user can never be left
 * existing with no way to reach any store. The matching site-database row is
 * written by the caller afterwards — a separate database, so no transaction
 * spans both; `linkControlAccount` is what reconciles them.
 */
export async function provisionControlAccount(
  granterUserId: number,
  existingId: number | null,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  /* ── THE PORTAL DECIDES, OR NOBODY DOES ──────────────────────────────────
   *
   * Unlike the reads above, a refusal here does NOT fall through. This writes
   * who may sign in, and re-running a save the portal rejected against the
   * direct connection would let a bad key quietly revert the one screen that
   * creates logins to the socket all of this exists to stop needing.
   *
   * usersPortal returns null only when it could not ask at all; a refusal
   * arrives as an ordinary { ok: false } the screen already knows how to show.
   * Validation still runs on the server either way — the portal's copy of it is
   * the authority on that path, not this one. */
  const viaPortal = await portal.provisionControlAccount(granterUserId, existingId, input)
  if (viaPortal) return viaPortal

  const problem = validate(input, existingId === null)
  if (problem) return { ok: false, error: problem }

  const email = input.email.trim().toLowerCase()

  const clash = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM cp2_users WHERE email = ? AND id <> ? LIMIT 1',
    [email, existingId ?? 0],
  )
  if (clash) return { ok: false, error: 'Another account already uses that email address.' }

  // Only sites the granter can reach may be handed out.
  const allowed = await query<RowDataPacket & { site_id: number }>(
    `SELECT site_id FROM cp2_user_sites
      WHERE user_id = ? AND status = 'active' AND site_id IN (${input.siteIds.map(() => '?').join(',')})`,
    [granterUserId, ...input.siteIds],
  )
  const allowedIds = new Set(allowed.map((r) => r.site_id))
  const refused = input.siteIds.filter((id) => !allowedIds.has(id))
  if (refused.length) {
    return { ok: false, error: 'You can only grant access to stores you can open yourself.' }
  }

  const defaultSiteId =
    input.defaultSiteId && input.siteIds.includes(input.defaultSiteId)
      ? input.defaultSiteId
      : input.siteIds[0]

  return transaction(async (tx) => {
    let userId = existingId

    if (userId === null) {
      const hash = await hashPassword(input.password!)
      const [res] = await tx.execute(
        `INSERT INTO cp2_users (email, password_hash, full_name, status, must_change_password)
         VALUES (?,?,?,?,1)`,
        [email, hash, input.fullName.trim(), input.isActive ? 'active' : 'suspended'],
      )
      userId = (res as { insertId: number }).insertId
    } else if (!input.claimedByEmail) {
      await tx.execute(
        `UPDATE cp2_users SET email = ?, full_name = ?, status = ? WHERE id = ?`,
        [email, input.fullName.trim(), input.isActive ? 'active' : 'suspended', userId],
      )
      if (input.password !== null) {
        const hash = await hashPassword(input.password)
        // must_change_password is set so an administrator who types a password
        // on someone's behalf does not end up knowing their live one.
        await tx.execute(
          `UPDATE cp2_users
              SET password_hash = ?, must_change_password = 1,
                  failed_attempts = 0, locked_until = NULL
            WHERE id = ?`,
          [hash, userId],
        )
      }
    }

    // Suspend links to sites that were unticked rather than deleting them, so
    // the history of who once had access survives. Scoped to the granter's own
    // sites: a store this administrator cannot see must not be revoked by a
    // save made from inside another one.
    await tx.execute(
      `UPDATE cp2_user_sites t
         INNER JOIN cp2_user_sites g ON g.site_id = t.site_id AND g.user_id = ? AND g.status = 'active'
          SET t.status = 'suspended'
        WHERE t.user_id = ?
          AND t.site_id NOT IN (${input.siteIds.map(() => '?').join(',')})`,
      [granterUserId, userId, ...input.siteIds],
    )

    for (const siteId of input.siteIds) {
      await tx.execute(
        `INSERT INTO cp2_user_sites (user_id, site_id, site_role, is_default, status)
         VALUES (?,?,?,?, 'active')
         ON DUPLICATE KEY UPDATE
           site_role = VALUES(site_role),
           is_default = VALUES(is_default),
           status = 'active'`,
        [userId, siteId, input.role, siteId === defaultSiteId ? 1 : 0],
      )
    }

    return { ok: true as const, controlUserId: userId!, adopted: input.claimedByEmail === true }
  })
}

/**
 * Revokes a person's access to one store, without touching their account.
 *
 * The portal acts on the store that SIGNED the request and can act on no other,
 * so it is only the right answer when this machine's key is for the store being
 * revoked. Everywhere else — a cloud back office, a dev checkout — the
 * statement below is.
 */
export async function revokeSiteAccess(controlUserId: number, siteId: number): Promise<void> {
  if (portalConfig()?.siteId === siteId && (await portal.revokeSiteAccess(controlUserId))) return

  await execute(
    `UPDATE cp2_user_sites SET status = 'suspended' WHERE user_id = ? AND site_id = ?`,
    [controlUserId, siteId],
  )
}
