import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { hashPassword, verifyPassword } from '../password'
import { mintVerifiersForAllDevices } from './offlineOperators'

/**
 * People, per site.
 *
 * Two kinds live in one table (see 041). A BACK OFFICE user has a control
 * account — email and password in cp2_users, possibly spanning several stores —
 * and also carries a PIN so the same person can work the till without signing
 * out. A POS ONLY user has no control account and no password: the PIN is the
 * whole credential, which is what lets a shop add a Saturday cashier without
 * giving them a way into the back office.
 *
 * THE PIN IS NOT STORED. It is bcrypt-hashed exactly like a password, which is
 * the reason `pinInUse` below has to loop rather than run a WHERE clause.
 */

/** Four or six digits. Nothing else — a till keypad has ten keys. */
const PIN_PATTERN = /^(\d{4}|\d{6})$/

export type UserType = 'back_office' | 'pos_only'

export type SiteUser = {
  id: number
  name: string
  email: string | null
  controlUserId: number | null
  userType: UserType
  roleId: number | null
  roleName: string | null
  isOwnerRole: boolean
  salesRepId: number | null
  salesRepName: string | null
  hasPin: boolean
  isActive: boolean
  lastLoginAt: string | null
}

type UserRow = RowDataPacket & {
  id: number
  name: string
  email: string | null
  control_user_id: number | null
  user_type: UserType
  role_id: number | null
  role_name: string | null
  is_owner: number | null
  sales_rep_id: number | null
  rep_name: string | null
  pin_hash: string | null
  is_active: number
  last_login_at: string | null
}

const SELECT_USER = `
  SELECT u.id, u.name, u.email, u.control_user_id, u.user_type, u.role_id,
         r.name AS role_name, r.is_owner,
         u.sales_rep_id, sr.name AS rep_name,
         u.pin_hash, u.is_active, u.last_login_at
    FROM users u
    LEFT JOIN roles r       ON r.id = u.role_id
    LEFT JOIN sales_reps sr ON sr.id = u.sales_rep_id
`

function mapUser(r: UserRow): SiteUser {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    controlUserId: r.control_user_id,
    userType: r.user_type,
    roleId: r.role_id,
    roleName: r.role_name,
    isOwnerRole: !!r.is_owner,
    salesRepId: r.sales_rep_id,
    salesRepName: r.rep_name,
    // The hash never leaves this module — a screen only needs to know whether
    // a PIN is set, never what it hashes to.
    hasPin: !!r.pin_hash,
    isActive: !!r.is_active,
    lastLoginAt: r.last_login_at,
  }
}

export async function listUsers(siteId: number): Promise<SiteUser[]> {
  const rows = await siteQuery<UserRow>(
    siteId,
    `${SELECT_USER} ORDER BY u.is_active DESC, u.name ASC`,
  )
  return rows.map(mapUser)
}

export async function getUser(siteId: number, userId: number): Promise<SiteUser | null> {
  const row = await siteQueryOne<UserRow>(siteId, `${SELECT_USER} WHERE u.id = ? LIMIT 1`, [userId])
  return row ? mapUser(row) : null
}

/** The local user for a control account, or null if they have no row here yet. */
export async function getUserByControlId(
  siteId: number,
  controlUserId: number,
): Promise<SiteUser | null> {
  const row = await siteQueryOne<UserRow>(
    siteId,
    `${SELECT_USER} WHERE u.control_user_id = ? LIMIT 1`,
    [controlUserId],
  )
  return row ? mapUser(row) : null
}

/**
 * Whether a PIN is already taken at this site.
 *
 * bcrypt salts every hash, so two identical PINs hash differently and no index
 * can answer this. Every active PIN has to be compared one at a time.
 *
 * That is affordable because the set is small — a shop has tens of users, not
 * thousands — and this runs when someone saves a user, not on a hot path. The
 * alternative is storing the PIN somewhere searchable, which means storing it
 * reversibly or unsalted, and a four-digit unsalted hash is a rainbow table
 * with 10,000 entries.
 */
async function pinInUse(siteId: number, pin: string, exceptUserId: number | null): Promise<boolean> {
  const rows = await siteQuery<RowDataPacket & { id: number; pin_hash: string }>(
    siteId,
    `SELECT id, pin_hash FROM users
      WHERE pin_hash IS NOT NULL AND is_active = 1 ${exceptUserId ? 'AND id <> ?' : ''}`,
    exceptUserId ? [exceptUserId] : [],
  )
  for (const row of rows) {
    if (await verifyPassword(pin, row.pin_hash)) return true
  }
  return false
}

export type UserSaveResult = { ok: true; id: number } | { ok: false; error: string }

export type UserInput = {
  name: string
  email: string | null
  userType: UserType
  roleId: number | null
  salesRepId: number | null
  /** Null leaves an existing PIN alone; a string replaces it. */
  pin: string | null
  isActive: boolean
}

async function validate(
  siteId: number,
  input: UserInput,
  userId: number | null,
): Promise<{ ok: false; error: string } | { ok: true; pinHash: string | null }> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Enter a name.' }
  if (name.length > 120) return { ok: false, error: 'That name is too long.' }

  if (input.userType === 'back_office' && !input.email?.trim()) {
    return { ok: false, error: 'A back office user needs an email address to sign in with.' }
  }

  if (input.pin !== null) {
    if (!PIN_PATTERN.test(input.pin)) {
      return { ok: false, error: 'A PIN must be 4 or 6 digits.' }
    }
    // A PIN that is one repeated digit or a straight run is guessable in the
    // handful of tries a person gets standing at a till in front of a queue.
    if (/^(\d)\1+$/.test(input.pin)) {
      return { ok: false, error: 'That PIN is too easy to guess. Avoid a single repeated digit.' }
    }
    if ('0123456789012345'.includes(input.pin) || '9876543210987654'.includes(input.pin)) {
      return { ok: false, error: 'That PIN is too easy to guess. Avoid consecutive digits.' }
    }
    if (await pinInUse(siteId, input.pin, userId)) {
      return { ok: false, error: 'That PIN is already in use. PINs identify who is at the till, so each must be unique.' }
    }
    return { ok: true, pinHash: await hashPassword(input.pin) }
  }

  // A POS-only user with no PIN has no way to sign in anywhere at all.
  if (input.userType === 'pos_only' && userId === null) {
    return { ok: false, error: 'A point of sale user needs a PIN — it is how they sign in.' }
  }

  return { ok: true, pinHash: null }
}

export async function createUser(siteId: number, input: UserInput): Promise<UserSaveResult> {
  const checked = await validate(siteId, input, null)
  if (!checked.ok) return checked

  const res = await siteExecute(
    siteId,
    `INSERT INTO users (name, email, user_type, role_id, sales_rep_id, pin_hash, is_active)
     VALUES (?,?,?,?,?,?,?)`,
    [
      input.name.trim(),
      input.email?.trim() || null,
      input.userType,
      input.roleId,
      input.salesRepId,
      checked.pinHash,
      input.isActive ? 1 : 0,
    ],
  )
  if (input.pin !== null) await mintVerifiersForAllDevices(siteId, res.insertId, input.pin)

  return { ok: true, id: res.insertId }
}

export async function updateUser(
  siteId: number,
  userId: number,
  input: UserInput,
): Promise<UserSaveResult> {
  const existing = await getUser(siteId, userId)
  if (!existing) return { ok: false, error: 'That user no longer exists.' }

  const checked = await validate(siteId, input, userId)
  if (!checked.ok) return checked

  // Losing the last active owner locks the site out of its own permissions
  // screen, and the only remedy is editing the database by hand.
  if (existing.isOwnerRole && (input.roleId !== existing.roleId || !input.isActive)) {
    const others = await siteQueryOne<RowDataPacket & { n: number }>(
      siteId,
      `SELECT COUNT(*) AS n FROM users u
         INNER JOIN roles r ON r.id = u.role_id
        WHERE r.is_owner = 1 AND u.is_active = 1 AND u.id <> ?`,
      [userId],
    )
    if (Number(others?.n ?? 0) === 0) {
      return { ok: false, error: 'This is the last active owner. Give someone else the owner role first.' }
    }
  }

  await siteExecute(
    siteId,
    `UPDATE users
        SET name = ?, email = ?, user_type = ?, role_id = ?, sales_rep_id = ?,
            is_active = ?${checked.pinHash ? ', pin_hash = ?' : ''}
      WHERE id = ?`,
    [
      input.name.trim(),
      input.email?.trim() || null,
      input.userType,
      input.roleId,
      input.salesRepId,
      input.isActive ? 1 : 0,
      ...(checked.pinHash ? [checked.pinHash] : []),
      userId,
    ],
  )
  // The offline verifier, minted from the PLAINTEXT — the only moment it exists,
  // since bcrypt does not give it back. Fail-soft inside; see the note there.
  if (input.pin !== null) await mintVerifiersForAllDevices(siteId, userId, input.pin)

  return { ok: true, id: userId }
}

/** Removes a PIN, leaving the person unable to sign in at the till. */
export async function clearPin(siteId: number, userId: number): Promise<{ ok: boolean; error?: string }> {
  const user = await getUser(siteId, userId)
  if (!user) return { ok: false, error: 'That user no longer exists.' }
  if (user.userType === 'pos_only') {
    return { ok: false, error: 'A point of sale user has no other way to sign in. Deactivate them instead.' }
  }
  await siteExecute(siteId, 'UPDATE users SET pin_hash = NULL WHERE id = ?', [userId])

  /* The offline verifiers go too, and this is not tidying up.
     A verifier left behind lets that person keep signing in at every offline till
     that already has it cached — for as long as its catalog goes unrefreshed, which
     is exactly the window in which somebody whose PIN was just revoked should NOT
     be able to open a drawer. Deleting the row is what makes the next catalog
     refresh drop them. */
  await siteExecute(siteId, 'DELETE FROM user_offline_verifiers WHERE user_id = ?', [userId]).catch(
    () => {},
  )
  return { ok: true }
}

/**
 * Links a local row to a control account.
 *
 * Used when a back-office account is provisioned upstream after the local row
 * already existed — the two halves are created in separate databases and there
 * is no transaction spanning them, so they can be made in either order.
 */
export async function linkControlAccount(
  siteId: number,
  userId: number,
  controlUserId: number,
  email: string,
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE users SET control_user_id = ?, email = ?, user_type = 'back_office' WHERE id = ?`,
    [controlUserId, email, userId],
  )
}

export type PinSignInResult =
  | { ok: true; user: SiteUser }
  | { ok: false; error: string }

/**
 * Identifies whoever typed a PIN at the till.
 *
 * There is no username, because a PIN is unique per site — that uniqueness is
 * the whole mechanism, and it is enforced at save time in `pinInUse`.
 *
 * Every active PIN is compared even after a match is found. Returning early
 * would make a wrong PIN measurably faster than a right one, and a timing
 * difference on a four-digit secret is worth more to an attacker than it
 * sounds. The cost is the same handful of bcrypt comparisons either way.
 */
export async function signInWithPin(siteId: number, pin: string): Promise<PinSignInResult> {
  const generic = { ok: false as const, error: 'That PIN was not recognised.' }
  if (!PIN_PATTERN.test(pin)) return generic

  const rows = await siteQuery<UserRow>(
    siteId,
    `${SELECT_USER} WHERE u.pin_hash IS NOT NULL AND u.is_active = 1`,
  )

  let match: UserRow | null = null
  for (const row of rows) {
    if (row.pin_hash && (await verifyPassword(pin, row.pin_hash))) match = match ?? row
  }
  if (!match) return generic

  await siteExecute(siteId, 'UPDATE users SET last_login_at = NOW() WHERE id = ?', [match.id])
  return { ok: true, user: mapUser(match) }
}
