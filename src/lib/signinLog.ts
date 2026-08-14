import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { query, execute } from './db'

/**
 * Who signed in to the back office, and who tried (003).
 *
 * Written from signIn() and never allowed to fail it — the logActivity rule:
 * a sign-in that succeeded must not be reported as failed because a log row
 * could not be written. Failures for unknown emails record too; that half is
 * what catches guessing.
 */

export type SignInEvent = 'success' | 'failed' | 'locked' | 'totp_failed'

export async function recordSignIn(e: {
  userId: number | null
  email: string
  event: SignInEvent
  ip?: string | null
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO cp2_signin_log (user_id, email, event, ip) VALUES (?,?,?,?)`,
      [e.userId, e.email.slice(0, 190), e.event, e.ip?.slice(0, 45) ?? null],
    )
  } catch {
    /* deliberately swallowed — see the header */
  }
}

export type SignInRow = {
  id: number
  userId: number | null
  email: string
  event: SignInEvent
  ip: string | null
  at: Date
}

/** Sign-ins by people linked to THIS site, newest first. */
export async function listSignIns(siteId: number, limit = 100): Promise<SignInRow[]> {
  const capped = Math.min(Math.max(limit, 1), 500)
  const rows = await query<RowDataPacket & Record<string, unknown>>(
    `SELECT l.id, l.user_id, l.email, l.event, l.ip, l.created_at
       FROM cp2_signin_log l
      WHERE l.user_id IN (SELECT user_id FROM cp2_user_sites WHERE site_id = ?)
         OR l.email IN (SELECT u.email FROM cp2_users u
                         JOIN cp2_user_sites us ON us.user_id = u.id WHERE us.site_id = ?)
      ORDER BY l.id DESC
      LIMIT ${capped}`,
    [siteId, siteId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    userId: r.user_id === null ? null : Number(r.user_id),
    email: String(r.email),
    event: String(r.event) as SignInEvent,
    ip: (r.ip as string | null) ?? null,
    at: r.created_at as Date,
  }))
}
