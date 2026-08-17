import 'server-only'
import { SignJWT, jwtVerify } from 'jose'
import { entitlementsForSite, has as hasModule } from './control/modules'

/**
 * The public storefront link token.
 *
 * The storefront has to know which store a visitor is shopping at, but a raw
 * siteId in a URL is an enumerable tenant identifier — change the 1 to a 2 and
 * you are looking at someone else's shop. So the link carries an opaque signed
 * token instead.
 *
 * DETERMINISTIC AND NON-EXPIRING, deliberately. The link gets printed on till
 * slips, stuck in a WhatsApp status and turned into a QR code on the door, so
 * regenerating it must always produce the same URL and a link shared last year
 * must still work. That rules out `iat`, `exp` and `jti` — any of them would
 * make the same store mint a different link on every call.
 *
 * THIS IS IDENTIFICATION, NOT AUTHORISATION. Holding the token gets a visitor
 * the storefront for that store and nothing else. What the storefront actually
 * exposes is governed by the store's own publish settings, which fail closed —
 * see `publishedProducts` in site/storefront.ts.
 */

/** Its own audience, so no other signed token in the app can be replayed here. */
const AUDIENCE = 'ody-public-store'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createPublicStoreToken(siteId: number): Promise<string> {
  return new SignJWT({ siteId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    // No iat/exp/jti — see the determinism note above.
    .sign(secret())
}

/**
 * Resolve a storefront token back to its siteId, or null when it is invalid —
 * or when the shop's plan no longer includes the Online Store.
 *
 * ── WHY THE MODULE CHECK IS HERE AND NOT IN A PAGE GUARD ────────────────────
 *
 * The storefront is served OUTSIDE the (app) route group. `requireSiteUser()`
 * never runs for it, so none of the back-office module guards apply — a visitor
 * is not signed in at all. This function is the one place every storefront
 * route resolves its store through, which makes it the only chokepoint that can
 * close the shop when the module lapses.
 *
 * ── AND WHY THIS ONE FAILS CLOSED ───────────────────────────────────────────
 *
 * The back-office entitlement read fails OPEN, because hiding half the menu
 * during a database blip looks like the application breaking. The opposite is
 * true here: a public shop front is either open for business or it is not, and
 * serving one for a shop that stopped paying is giving the product away to
 * members of the public. A storefront that is briefly unreachable reads as a
 * site being down, which is an ordinary thing for a website to be.
 */
export async function verifyPublicStoreToken(token: string): Promise<number | null> {
  let siteId: number
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const parsed = Number(payload.siteId)
    if (!Number.isInteger(parsed) || parsed <= 0) return null
    siteId = parsed
  } catch {
    return null
  }

  try {
    const entitlements = await entitlementsForSite(siteId)
    return hasModule(entitlements, 'online_store') ? siteId : null
  } catch {
    // See the docblock: closed, not open.
    console.error('[modules] could not verify the storefront module; closing the shop front')
    return null
  }
}
