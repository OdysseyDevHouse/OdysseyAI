import { NextResponse, type NextRequest } from 'next/server'
import { clearSessionCookie } from '@/lib/session'
import { revokeDevice, userForToken } from '@/lib/control/mobileDevices'
import { queryOne } from '@/lib/db'
import type { RowDataPacket } from 'mysql2'

type Row = RowDataPacket & Record<string, unknown>

/**
 * Signing out ON the device — the app's own "sign out" button.
 *
 * Distinct from revoking a phone you no longer hold, which happens in the back
 * office against the device list and needs a session rather than the token.
 * This one is authenticated by the token itself, because it is the token's
 * holder asking to destroy it.
 *
 * Answers 204 whether or not anything was revoked. A caller signing out cannot
 * act on "that token was already dead" — and answering differently would let an
 * unauthenticated caller test token strings for validity.
 */
export async function POST(req: NextRequest) {
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  if (token) {
    const userId = await userForToken(token)
    if (userId !== null) {
      /* userForToken() resolves the user but not the row, and revokeDevice()
         scopes by both so that no id but this token's own can be revoked here. */
      const row = await queryOne<Row>(
        `SELECT id FROM odyssey_mobile_devices WHERE token_hash = SHA2(?, 256) LIMIT 1`,
        [token],
      )
      if (row) await revokeDevice(userId, Number(row.id))
    }
  }

  // The session this device was handed, too — otherwise it keeps working for up
  // to twelve hours after the user pressed "sign out", which is not what those
  // words mean.
  await clearSessionCookie()

  return new NextResponse(null, { status: 204 })
}
