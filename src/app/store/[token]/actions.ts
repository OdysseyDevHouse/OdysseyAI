'use server'

import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { submitReview, type SaveResult } from '@/lib/site/productReviews'

/**
 * Writes an anonymous shopper is allowed to make.
 *
 * ── THE TOKEN IS RE-VERIFIED HERE ────────────────────────────────────────
 *
 * A server action is a public HTTP endpoint. The page that renders the form
 * already checked the token, but that check protects the PAGE, not this — a
 * script can call the action directly with any token it likes. So the token is
 * resolved to a site again, from scratch, on every call.
 *
 * ── AND SO IS THE SETTING ────────────────────────────────────────────────
 *
 * A shop with reviews switched off must not accept one just because someone
 * kept a form open, or forged the request. The gate is the store's setting,
 * checked server-side, not the absence of a form in the page.
 */

export async function submitReviewAction(
  token: string,
  input: {
    productId: number
    rating: number
    title: string
    body: string
    authorName: string
    orderNumber: string
    /** Hidden field. A human never fills this in. */
    website: string
  },
): Promise<SaveResult> {
  /*
   * A bot filled the honeypot. Report SUCCESS and write nothing: an error
   * teaches a scripted submitter which field gave it away, where a cheerful
   * "thanks" teaches it nothing and costs us nothing.
   */
  if (input.website.trim()) return { ok: true }

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return { ok: false, error: 'This shop is not available.' }

  const context = await storefrontContext(siteId)
  if (!context) return { ok: false, error: 'This shop is not available.' }
  if (!context.settings.reviewsEnabled) {
    return { ok: false, error: 'This shop is not taking reviews.' }
  }

  return submitReview(siteId, {
    productId: Number(input.productId),
    rating: Number(input.rating),
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    authorName: String(input.authorName ?? ''),
    orderNumber: String(input.orderNumber ?? ''),
  })
}
