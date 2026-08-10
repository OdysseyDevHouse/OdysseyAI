import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The link that lets a guest follow their order.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * A signed-in customer sees their orders on the account page. A GUEST — which
 * is the ordinary case for a corner shop — got the confirmation screen and then
 * nothing at all, so the only way to ask "is it ready yet" was to phone the
 * shop. That is exactly the call the online store was meant to remove.
 *
 * ── IT EXPIRES, UNLIKE THE STORE TOKEN ───────────────────────────────────
 *
 * publicStoreToken is deliberately eternal: it is printed on till slips and
 * turned into QR codes, and it identifies a SHOP, which is public anyway.
 *
 * This one is the opposite. It reveals one person's name, phone number,
 * delivery address and what they bought, so a permanent link is a permanent
 * leak the moment the email is forwarded, screenshotted into a group chat, or
 * left in a shared inbox. Ninety days is long past when anyone still cares
 * where their bread got to, and short enough that an old email stops being a
 * key to someone's address.
 *
 * ── IT NAMES ONE ORDER, AND ONE SITE ─────────────────────────────────────
 *
 * Both are checked on the way back in. Order ids are per-site, so a token
 * minted at one store must never resolve at another — without the siteId check
 * the same integer would address a different person's order in a different
 * shop's database.
 *
 * ── IT IS SIGHT, NOT CONTROL ─────────────────────────────────────────────
 *
 * Holding this token shows the order. It cannot cancel it, change it, reorder
 * it, or reach anything else the shopper has ever bought. Anything that
 * changes an order stays behind a real customer session or the back office.
 */

/** Its own audience, so no other signed token in the app can be replayed here. */
const AUDIENCE = 'ody-order-track'

/** Long enough to outlive any real delivery, short enough to stop being a key. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90

export type OrderTrackClaim = {
  siteId: number
  orderId: number
}

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createOrderTrackToken(claim: OrderTrackClaim): Promise<string> {
  return new SignJWT({ siteId: claim.siteId, orderId: claim.orderId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret())
}

/**
 * Resolve a tracking link back to the order it names, or null.
 *
 * Null for every failure — bad signature, wrong audience, expired, malformed.
 * The route turns all of them into the same 404, so the link cannot be used to
 * probe which orders exist.
 */
export async function readOrderTrackToken(token: string): Promise<OrderTrackClaim | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    const orderId = Number(payload.orderId)
    if (!Number.isInteger(siteId) || siteId <= 0) return null
    if (!Number.isInteger(orderId) || orderId <= 0) return null
    return { siteId, orderId }
  } catch {
    return null
  }
}
