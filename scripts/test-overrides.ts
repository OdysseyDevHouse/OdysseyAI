/**
 * Supervisor overrides — the token, the live re-check, and the audit trail.
 *
 * What must hold:
 *
 *   THE TOKEN IS THE AUTHORITY, NOT A NAME. A client-sent "authorisedBy" is a
 *   string the client chose; only a token signed with the site secret widens
 *   anything, and only for the ONE capability baked into it.
 *
 *   RIGHTS ARE RE-CHECKED LIVE. A manager whose permission is withdrawn inside
 *   the two-minute window authorises nothing — the token alone is not enough.
 *
 *   THE LOCKOUT MATH CANNOT STRAND A CASHIER. Reaching the ceiling zeroes the
 *   counter — the lockout IS the punishment, and the next window starts fresh.
 */

import { SignJWT } from 'jose'
import { createOverrideToken, verifyOverrideToken } from '../src/lib/overrideToken'
import { afterWrongPin, lockoutRemaining, MAX_ATTEMPTS, LOCKOUT_MS } from '../src/lib/posOffline/signInOffline'
import { logActivity } from '../src/lib/site/activityLog'
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'

const SITE = 1

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-6)
let roleId = 0
let userId = 0

async function main() {
  console.log('\n── Fixtures: a manager with exactly one right ──────────────\n')

  const role = await siteExecute(SITE, `INSERT INTO roles (name) VALUES (?)`, [
    `Override Test ${stamp}`,
  ])
  roleId = role.insertId
  await siteExecute(
    SITE,
    `INSERT INTO role_permissions (role_id, capability, allowed) VALUES (?, 'sales.void', 1)`,
    [roleId],
  )
  const user = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, role_id, is_active) VALUES (?, 'pos_only', ?, 1)`,
    [`Override Manager ${stamp}`, roleId],
  )
  userId = user.insertId

  console.log('\n── The token round trip ────────────────────────────────────\n')

  const token = await createOverrideToken({
    siteId: SITE,
    userId,
    userName: `Override Manager ${stamp}`,
    capability: 'sales.void',
  })
  const verified = await verifyOverrideToken(SITE, token, 'sales.void')
  ok('*** a fresh token verifies ***', verified !== null)
  ok('…and names the manager', verified?.userId === userId, String(verified?.userId))

  ok('*** the wrong capability refuses ***',
      (await verifyOverrideToken(SITE, token, 'sales.discount_override')) === null)
  ok('the wrong site refuses',
      (await verifyOverrideToken(SITE + 999, token, 'sales.void')) === null)
  ok('garbage refuses', (await verifyOverrideToken(SITE, 'not-a-token', 'sales.void')) === null)

  // An expired token, forged with the real secret — expiry is the only lie.
  const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? '')
  const expired = await new SignJWT({
    siteId: SITE, userId, userName: 'x', capability: 'sales.void', kind: 'pos_override',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 300)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(secret)
  ok('*** an expired token refuses ***',
      (await verifyOverrideToken(SITE, expired, 'sales.void')) === null)

  // A token whose kind is not pos_override must not cross over from another JWT.
  const wrongKind = await new SignJWT({
    siteId: SITE, userId, userName: 'x', capability: 'sales.void',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('120s')
    .sign(secret)
  ok('*** a till-session-shaped JWT is not an override ***',
      (await verifyOverrideToken(SITE, wrongKind, 'sales.void')) === null)

  console.log('\n── Rights are re-checked live ──────────────────────────────\n')

  // Withdraw the permission INSIDE the token's window.
  await siteExecute(SITE, `DELETE FROM role_permissions WHERE role_id = ?`, [roleId])
  ok('*** a permission withdrawn mid-window refuses the still-valid token ***',
      (await verifyOverrideToken(SITE, token, 'sales.void')) === null)

  await siteExecute(
    SITE,
    `INSERT INTO role_permissions (role_id, capability, allowed) VALUES (?, 'sales.void', 1)`,
    [roleId],
  )
  ok('…and restoring it verifies again', (await verifyOverrideToken(SITE, token, 'sales.void')) !== null)

  await siteExecute(SITE, `UPDATE users SET is_active = 0 WHERE id = ?`, [userId])
  ok('*** a deactivated manager authorises nothing ***',
      (await verifyOverrideToken(SITE, token, 'sales.void')) === null)
  await siteExecute(SITE, `UPDATE users SET is_active = 1 WHERE id = ?`, [userId])

  console.log('\n── The audit row ───────────────────────────────────────────\n')

  await logActivity(SITE, { userId, userName: `Override Manager ${stamp}` }, {
    entity: 'pos_override',
    entityId: null,
    action: 'sales.discount_override',
    detail: `25% discount on Bread · cashier Ann · R12.50 · till T1-${stamp}`,
  })
  const rows = await siteQuery<{ action: string; detail: string; user_name: string }>(
    SITE,
    `SELECT action, detail, user_name FROM activity_log
      WHERE entity = 'pos_override' AND detail LIKE ?`,
    [`%${stamp}%`],
  )
  ok('*** the override is on the record ***', rows.length === 1, JSON.stringify(rows))
  ok('…under the MANAGER’s name', rows[0]?.user_name.includes('Override Manager'))
  ok('…naming the action and the cashier',
      (rows[0]?.detail ?? '').includes('discount') && (rows[0]?.detail ?? '').includes('Ann'))

  console.log('\n── The offline lockout math ────────────────────────────────\n')

  let attempts = { count: 0, lockedUntil: null as number | null }
  const t0 = 1_000_000
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    attempts = afterWrongPin(attempts, t0)
    ok(`wrong PIN ${i} counts and does not lock`, attempts.count === i && attempts.lockedUntil === null)
  }
  attempts = afterWrongPin(attempts, t0)
  ok('*** the ceiling locks ***', attempts.lockedUntil === t0 + LOCKOUT_MS)
  ok('*** and ZEROES the counter — no permanent lockout ***', attempts.count === 0)
  ok('the pad refuses during the window', lockoutRemaining(attempts, t0 + 1000) > 0)
  ok('…and relents after it', lockoutRemaining(attempts, t0 + LOCKOUT_MS + 1) === 0)

  console.log('\n── Cleanup ────────────────────────────────────────────────\n')

  await siteExecute(SITE, `DELETE FROM activity_log WHERE entity = 'pos_override' AND detail LIKE ?`, [
    `%${stamp}%`,
  ])
  await siteExecute(SITE, `DELETE FROM users WHERE id = ?`, [userId])
  await siteExecute(SITE, `DELETE FROM role_permissions WHERE role_id = ?`, [roleId])
  await siteExecute(SITE, `DELETE FROM roles WHERE id = ?`, [roleId])
  const left = await siteQueryOne<{ n: unknown }>(
    SITE,
    `SELECT COUNT(*) AS n FROM roles WHERE name LIKE ?`,
    [`Override Test ${stamp}%`],
  )
  ok('test data cleaned up', Number(left?.n) === 0)

  console.log(fails === 0 ? '\nAll override rules hold.\n' : `\n${fails} FAILURE(S)\n`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
