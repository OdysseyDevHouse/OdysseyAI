import 'server-only'
import { SignJWT, jwtVerify } from 'jose'
import { getUser } from './site/users'
import { capabilitiesForRole, can, type Capability } from './site/permissions'

/**
 * A manager's one-time say-so, as a token.
 *
 * A cashier hits a refusal — a discount over the cap, a void, a return — and a
 * manager types their PIN. That mints THIS: a short-lived, single-capability
 * token the till attaches to exactly one action. The server verifies the token
 * instead of trusting a client-sent "authorisedBy" — a name in a payload is a
 * name the client chose, where a signature is not.
 *
 * TWO MINUTES, ONE CAPABILITY. Long enough to finish the tap that was refused,
 * short enough that a manager's PIN typed at 10:00 authorises nothing at 10:05.
 * The capability is baked in, so a token minted for a discount cannot be
 * replayed against a void.
 *
 * Verification RE-CHECKS THE ROLE LIVE: a permission withdrawn inside the
 * two-minute window still refuses — the same per-request freshness rule
 * `requireSiteUser` applies to everyone else.
 */

const OVERRIDE_TTL_SECONDS = 120

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET
  if (!value) throw new Error('SESSION_SECRET is not set')
  return new TextEncoder().encode(value)
}

export async function createOverrideToken(payload: {
  siteId: number
  userId: number
  userName: string
  capability: string
}): Promise<string> {
  return new SignJWT({ ...payload, kind: 'pos_override' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${OVERRIDE_TTL_SECONDS}s`)
    .sign(secret())
}

/**
 * The authoriser, or null — bad signature, expired, wrong site, wrong
 * capability, or a right the manager no longer holds.
 */
export async function verifyOverrideToken(
  siteId: number,
  token: string,
  capability: Capability,
): Promise<{ userId: number; userName: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret())
    if (payload.kind !== 'pos_override') return null
    if (Number(payload.siteId) !== siteId) return null
    if (String(payload.capability) !== capability) return null

    const userId = Number(payload.userId)
    const manager = await getUser(siteId, userId)
    if (!manager || !manager.isActive) return null
    const capabilities = await capabilitiesForRole(siteId, manager.roleId)
    if (!can(capabilities, capability)) return null

    return { userId, userName: manager.name }
  } catch {
    return null
  }
}
