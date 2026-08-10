import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

/**
 * A short-lived pass to look at an UNPUBLISHED page on the real storefront.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * The builder's canvas is `pointer-events-none`, so an owner cannot click
 * through their own draft — every link and button is inert by design, because
 * a stray click in the preview must not navigate the admin away or add to a
 * basket. "View shop" only ever showed what was already published.
 *
 * So there was no way at all to walk the real journey before publishing it.
 * This is that: the actual storefront, at the actual URL, rendering the draft.
 *
 * ── EVERY PROPERTY IS THE OPPOSITE OF THE STORE TOKEN ────────────────────
 *
 * `publicStoreToken` is deterministic and never expires, because it goes on
 * till slips and QR codes. This one must be neither:
 *
 *   EXPIRING, because it shows work the owner has deliberately not published.
 *   A link pasted into a chat should stop working, and fifteen minutes is
 *   longer than it takes to check a page and shorter than a lunch break.
 *
 *   PAGE-SCOPED, because the answer to "may I see this draft" is per page. A
 *   pass to preview the Delivery page is not a pass to read every unpublished
 *   page the shop has.
 *
 *   AUDIENCED SEPARATELY, so a storefront token can never be replayed as a
 *   preview pass, and a preview pass can never be used as a shop link.
 *
 * ── IT SHOWS A DRAFT; IT DOES NOT GRANT ANYTHING ─────────────────────────
 *
 * Holding one renders one page's draft sections. It does not open a closed
 * shop, does not bypass the publish rules on what may be sold, and does not
 * reach the admin. Everything a preview renders goes through the same
 * `resolveSectionContent` a shopper's request does.
 */

/** Its own audience — see the note above on replay. */
const AUDIENCE = 'ody-page-preview'

/**
 * How long a pass lasts.
 *
 * Long enough to open the link, read the page and scroll back up; short enough
 * that a link forwarded to somebody else has almost certainly died before they
 * open it. Deliberately not configurable — a shop that could set this to a
 * year would have re-invented publishing, without the safety of it.
 */
const TTL = '15m'

export type PreviewClaim = { siteId: number; pageId: number }

export async function createPreviewToken(siteId: number, pageId: number): Promise<string> {
  return new SignJWT({ siteId, pageId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(secret())
}

/**
 * Resolve a preview pass, or null when it is invalid or has expired.
 *
 * `jwtVerify` checks `exp` itself, so an expired pass fails here rather than
 * being handed to a caller that has to remember to check a timestamp.
 */
export async function verifyPreviewToken(token: string): Promise<PreviewClaim | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE })
    const siteId = Number(payload.siteId)
    const pageId = Number(payload.pageId)
    if (!Number.isInteger(siteId) || siteId <= 0) return null
    if (!Number.isInteger(pageId) || pageId <= 0) return null
    return { siteId, pageId }
  } catch {
    return null
  }
}

function secret(): Uint8Array {
  const raw = process.env.SESSION_SECRET
  if (!raw) throw new Error('SESSION_SECRET is not configured.')
  return new TextEncoder().encode(raw)
}
