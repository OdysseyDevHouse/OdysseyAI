import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * The portal link token — which business this portal belongs to.
 *
 * ── WHY THE PORTAL NEEDS ONE AT ALL ────────────────────────────────────────
 *
 * This app has no host-to-site resolution: every tenant is served from the same
 * origin, and the storefront answers the "which shop is this" question with a
 * signed token in the URL for exactly that reason. The portal has the same
 * problem and takes the same answer.
 *
 * It also earns its keep twice over. The customer session carries a siteId and
 * getCustomerSession refuses a session minted at another site — so the token in
 * the path and the token in the cookie must AGREE, and a session from one
 * business cannot be replayed at another even though customer ids collide
 * across sites.
 *
 * ── ITS OWN AUDIENCE ───────────────────────────────────────────────────────
 *
 * A storefront link, a booking link, an intake link and a portal link all carry
 * nothing but a siteId, and none may be replayed as another. The audience is
 * what makes that impossible.
 *
 * ── DETERMINISTIC AND NON-EXPIRING ─────────────────────────────────────────
 *
 * This is the href behind "your account" on the business's own website and in
 * the footer of every email it sends. Regenerating it must produce the same URL.
 *
 * ── IDENTIFICATION, NOT AUTHORISATION ──────────────────────────────────────
 *
 * Holding it gets a visitor the sign-in page for that business and nothing else.
 * Everything past it needs a customer session, which needs a link sent to an
 * address already on the customer record.
 */

const AUDIENCE = 'ody-portal'

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}

export async function createPortalToken(siteId: number): Promise<string> {
  return new SignJWT({ siteId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .sign(secret())
}

/** The site this portal belongs to, or null for every kind of failure. */
export async function verifyPortalToken(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    if (!Number.isInteger(siteId) || siteId <= 0) return null
    return siteId
  } catch {
    return null
  }
}
