import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, queryOne, execute } from './db'
import { encryptSecret, decryptSecret } from './crypto/secrets'
import { generateTotpSecret, verifyTotp, otpauthUri } from './totp'

/**
 * Two-factor sign-in for back-office users (004).
 *
 * ── ENFORCEMENT STARTS AT CONFIRMATION, NOT PROVISIONING ─────────────────
 *
 * A secret is minted, shown once, and only starts guarding the account when
 * its owner proves they scanned it by typing a live code. A half-finished
 * enrolment must never lock its owner out.
 *
 * ── A CODE IS SINGLE-USE ─────────────────────────────────────────────────
 *
 * The conditional UPDATE on last_used_step is the guard: whoever lands the
 * step first wins, and the same code pasted twice — or shoulder-surfed —
 * fails the second time. This is why verifyTotp returns the matched step.
 */

type Row = RowDataPacket & Record<string, unknown>

export type Result = { ok: true } | { ok: false; error: string }

export async function totpStatus(
  controlUserId: number,
): Promise<{ enabled: boolean; pending: boolean }> {
  const row = await queryOne<Row>(
    'SELECT confirmed_at FROM cp2_user_totp WHERE user_id = ?',
    [controlUserId],
  )
  if (!row) return { enabled: false, pending: false }
  return { enabled: row.confirmed_at !== null, pending: row.confirmed_at === null }
}

/** For the users screen: which of these accounts carry confirmed 2FA. */
export async function totpEnabledMap(controlUserIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(controlUserIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return new Set()
  const rows = await query<Row>(
    `SELECT user_id FROM cp2_user_totp
      WHERE confirmed_at IS NOT NULL AND user_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  return new Set(rows.map((r) => Number(r.user_id)))
}

/** Mints (or re-mints) an UNCONFIRMED secret. Refuses while one is live. */
export async function beginTotpEnrolment(
  controlUserId: number,
  email: string,
): Promise<{ ok: true; secret: string; uri: string } | { ok: false; error: string }> {
  const status = await totpStatus(controlUserId)
  if (status.enabled) {
    return { ok: false, error: 'Two-factor is already on — turn it off first to re-enrol.' }
  }

  const secret = generateTotpSecret()
  await execute(
    `INSERT INTO cp2_user_totp (user_id, secret_enc)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE secret_enc = VALUES(secret_enc), confirmed_at = NULL, last_used_step = 0`,
    [controlUserId, encryptSecret(secret)],
  )
  return { ok: true, secret, uri: otpauthUri({ secret, accountName: email }) }
}

export async function confirmTotpEnrolment(
  controlUserId: number,
  code: string,
): Promise<Result> {
  const row = await queryOne<Row>(
    'SELECT secret_enc, confirmed_at FROM cp2_user_totp WHERE user_id = ?',
    [controlUserId],
  )
  if (!row) return { ok: false, error: 'Start again — there is nothing to confirm.' }
  if (row.confirmed_at !== null) return { ok: false, error: 'Two-factor is already on.' }

  const check = verifyTotp(decryptSecret(String(row.secret_enc)), code)
  if (!check.ok) {
    return { ok: false, error: 'That code did not match. Check the app and try the next one.' }
  }
  await execute(
    'UPDATE cp2_user_totp SET confirmed_at = NOW(), last_used_step = ? WHERE user_id = ?',
    [check.step, controlUserId],
  )
  return { ok: true }
}

/** The sign-in check. Single-use by the conditional UPDATE — see the header. */
export async function verifySignInCode(controlUserId: number, code: string): Promise<boolean> {
  const row = await queryOne<Row>(
    'SELECT secret_enc FROM cp2_user_totp WHERE user_id = ? AND confirmed_at IS NOT NULL',
    [controlUserId],
  )
  if (!row) return false

  const check = verifyTotp(decryptSecret(String(row.secret_enc)), code)
  if (!check.ok) return false

  const claim = await execute(
    'UPDATE cp2_user_totp SET last_used_step = ? WHERE user_id = ? AND last_used_step < ?',
    [check.step, controlUserId, check.step],
  )
  return claim.affectedRows === 1
}

/** Turning it off is itself gated by a live code — a found unlocked laptop
    must not be enough to strip the protection. */
export async function disableTotp(controlUserId: number, code: string): Promise<Result> {
  const good = await verifySignInCode(controlUserId, code)
  if (!good) return { ok: false, error: 'That code did not match — two-factor stays on.' }
  await execute('DELETE FROM cp2_user_totp WHERE user_id = ?', [controlUserId])
  return { ok: true }
}

/** Admin recovery: an owner clears a colleague's lost authenticator. No code
    — the whole point is that the code is gone. The CALLER audits it. */
export async function clearTotp(controlUserId: number): Promise<void> {
  await execute('DELETE FROM cp2_user_totp WHERE user_id = ?', [controlUserId])
}
