import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute, transaction } from './db'
import { hashPassword } from './password'

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
 */

/** Back-office passwords are set by an administrator, so this is the floor. */
export const MIN_CONTROL_PASSWORD = 10

export type ControlAccount = {
  id: number
  email: string
  fullName: string | null
  status: 'active' | 'suspended'
  mustChangePassword: boolean
  lastLoginAt: string | null
}

export type SiteGrant = {
  siteId: number
  siteCode: string
  displayName: string
  role: 'owner' | 'manager' | 'staff'
  isDefault: boolean
  granted: boolean
}

export async function findControlAccountByEmail(email: string): Promise<ControlAccount | null> {
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
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    mustChangePassword: !!row.must_change_password,
    lastLoginAt: row.last_login_at,
  }
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

export type ProvisionResult = { ok: true; controlUserId: number } | { ok: false; error: string }

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
}

function validate(input: ProvisionInput, isNew: boolean): string | null {
  const email = input.email.trim().toLowerCase()
  if (!email) return 'Enter an email address.'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'That email address does not look right.'
  if (!input.fullName.trim()) return 'Enter a name.'
  if (!input.siteIds.length) return 'Choose at least one store this person may open.'

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
    } else {
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

    return { ok: true as const, controlUserId: userId! }
  })
}

/** Revokes a person's access to one store, without touching their account. */
export async function revokeSiteAccess(controlUserId: number, siteId: number): Promise<void> {
  await execute(
    `UPDATE cp2_user_sites SET status = 'suspended' WHERE user_id = ? AND site_id = ?`,
    [controlUserId, siteId],
  )
}
