import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { execute, query, queryOne } from '@/lib/db'

/**
 * Enrolled phones and tablets, and the refresh tokens that keep them signed in.
 *
 * ── WHAT A REFRESH TOKEN IS FOR ─────────────────────────────────────────────
 *
 * The session is a twelve-hour JWT. That is right for a browser and wrong for
 * an app: a manager who opens the dashboard each morning would meet a login
 * form inside a WebView each morning, which is exactly what makes a native
 * wrapper feel like a browser with a nicer icon.
 *
 * So the app signs in ONCE and keeps an opaque token in the platform keystore.
 * On every cold start it trades that token for a fresh session. The token is
 * the long-lived credential; the session stays as short as it always was.
 *
 * ── IT IS A CREDENTIAL, NOT AN IDENTIFIER ───────────────────────────────────
 *
 * Unlike `deviceId()` — which is a UUID the server re-validates and therefore
 * buys a spoofer nothing — anyone holding one of these IS the user until the
 * row is revoked. Hence: 32 bytes of CSPRNG, hashed at rest, compared in
 * constant time, and revocable one row at a time.
 *
 * ── WHY THE HASH IS SHA-256 AND NOT BCRYPT ──────────────────────────────────
 *
 * A password is guessable and so must be made expensive to guess. This is not:
 * it is 256 bits of randomness with no dictionary behind it, so a slow KDF
 * would buy no security and cost a delay on every app launch. Same reasoning as
 * `site/apiKeys.ts`, which stores its keys the same way.
 */

type Row = RowDataPacket & Record<string, unknown>

/** Where an enrolment came from. Free text in the column; narrow here. */
export type MobilePlatform = 'ios' | 'android'

export function isMobilePlatform(value: unknown): value is MobilePlatform {
  return value === 'ios' || value === 'android'
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * A device as the "signed-in devices" list shows it.
 *
 * No token and no hash — this is what a person reads while deciding which row
 * to revoke, and the digest is not their business.
 */
export type EnrolledDevice = {
  id: number
  platform: string
  label: string
  createdAt: Date
  lastSeenAt: Date | null
}

/**
 * Enrol a device and return the ONE copy of its token that will ever exist.
 *
 * The plaintext is never stored and cannot be recovered — a user who loses it
 * enrols again, which is the same act as signing in again. That is deliberate:
 * a token this codebase could reprint is a token a stolen backup could reprint.
 */
export async function enrolDevice(
  userId: number,
  platform: MobilePlatform,
  label: string,
): Promise<{ token: string; deviceId: number }> {
  /* base64url of 32 bytes: URL- and header-safe, so the app can put it in an
     Authorization header without escaping anything. */
  const token = randomBytes(32).toString('base64url')

  const result = await execute(
    `INSERT INTO odyssey_mobile_devices (user_id, token_hash, platform, label, last_seen_at)
     VALUES (?, ?, ?, ?, NOW())`,
    [userId, sha256hex(token), platform, label.trim().slice(0, 120) || 'Mobile device'],
  )

  return { token, deviceId: result.insertId }
}

/**
 * Who does this token belong to, if anybody?
 *
 * Never throws, and every failure — malformed token, unknown token, revoked
 * device, unreachable database — returns null. The caller answers all of them
 * with the same 401, so the response cannot be used to learn which token
 * strings are real.
 *
 * NOTE what this deliberately does NOT check: whether the user still exists,
 * is active, or still has access to any site. That is not laziness — those are
 * re-read from `cp2_users` and `cp2_user_sites` when the session is minted, on
 * every exchange, so revoking access upstream takes effect on the next app
 * launch without anybody having to remember to touch this table too.
 */
export async function userForToken(token: string): Promise<number | null> {
  try {
    if (!token || token.length < 20 || token.length > 200) return null

    const row = await queryOne<Row>(
      `SELECT id, user_id, token_hash, revoked_at
         FROM odyssey_mobile_devices
        WHERE token_hash = ?
        LIMIT 1`,
      [sha256hex(token)],
    )
    if (!row) return null

    /* The lookup above already matched on the digest, so this compare can only
       fail if the column holds something the wrong length. It is here anyway
       because the day someone changes that query to a prefix lookup — the way
       apiKeys.ts does — this is the line that has to already exist. */
    const stored = Buffer.from(String(row.token_hash), 'utf8')
    const presented = Buffer.from(sha256hex(token), 'utf8')
    if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) return null

    if (row.revoked_at !== null) return null

    await touch(Number(row.id))
    return Number(row.user_id)
  } catch {
    return null
  }
}

/**
 * Stamp `last_seen_at`, so a device silent for months is visibly the safe one
 * to revoke.
 *
 * Fail-soft, unlike `claimSession`: a missing stamp costs a support question
 * some accuracy, while a throw here would fail an app launch that is otherwise
 * entirely valid. The two are not the same kind of write.
 */
async function touch(deviceId: number): Promise<void> {
  try {
    await execute(`UPDATE odyssey_mobile_devices SET last_seen_at = NOW() WHERE id = ?`, [deviceId])
  } catch {
    /* ignored, deliberately — see above */
  }
}

/** One user's live devices, newest first. */
export async function listDevices(userId: number): Promise<EnrolledDevice[]> {
  const rows = await query<Row>(
    `SELECT id, platform, label, created_at, last_seen_at
       FROM odyssey_mobile_devices
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [userId],
  )

  return rows.map((r) => ({
    id: Number(r.id),
    platform: String(r.platform),
    label: String(r.label),
    createdAt: r.created_at as Date,
    lastSeenAt: (r.last_seen_at as Date | null) ?? null,
  }))
}

/**
 * Cut a device off.
 *
 * `user_id` is in the WHERE rather than trusted from the caller's argument
 * alone, so a wrong or hostile id cannot revoke somebody else's phone. Returns
 * whether a row was actually affected — the caller reports "already revoked"
 * rather than claiming a success that did nothing.
 *
 * Marked, not deleted: "when did we cut that phone off?" should survive the act
 * of cutting it off.
 */
export async function revokeDevice(userId: number, deviceId: number): Promise<boolean> {
  const result = await execute(
    `UPDATE odyssey_mobile_devices
        SET revoked_at = NOW()
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [deviceId, userId],
  )
  return result.affectedRows > 0
}

/** Every device for a user — the "sign out everywhere" of the mobile estate. */
export async function revokeAllDevices(userId: number): Promise<number> {
  const result = await execute(
    `UPDATE odyssey_mobile_devices
        SET revoked_at = NOW()
      WHERE user_id = ? AND revoked_at IS NULL`,
    [userId],
  )
  return result.affectedRows
}
