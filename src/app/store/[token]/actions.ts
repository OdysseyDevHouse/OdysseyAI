'use server'

import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import {
  publishedProducts,
  storefrontContext,
  type StorefrontProduct,
} from '@/lib/site/storefront'
import { submitReview, type SaveResult } from '@/lib/site/productReviews'
import { subscribe, type SubscribeResult } from '@/lib/site/storefrontSubscribers'
import { DEFAULT_CONSENT_TEXT } from '@/lib/storefrontModel'
import { MAX_WISHLIST } from '@/lib/wishlist'

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

/**
 * The saved products, for a wishlist held in the browser.
 *
 * Goes through `publishedProducts`, so the shop's publish rules apply exactly
 * as they do everywhere else: an id that is not published resolves to nothing
 * rather than being served because someone asked for it by number.
 *
 * It returns FEWER products than were asked for when some are unavailable, and
 * the caller reports that gap rather than hiding it.
 */
export async function wishlistProductsAction(
  token: string,
  ids: number[],
): Promise<StorefrontProduct[]> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return []
  const context = await storefrontContext(siteId)
  if (!context) return []

  const wanted = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  if (wanted.length === 0) return []

  /*
   * 120 is publishedProducts's own hard ceiling on `limit`. Asking for more
   * would be silently clamped there and quietly drop saved items, which the
   * page would then report as "no longer available" — so the wishlist cap
   * matches it rather than exceeding it.
   */
  return publishedProducts(context, { ids: wanted.slice(0, MAX_WISHLIST), limit: MAX_WISHLIST })
}

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

/**
 * Put somebody on the shop's mailing list.
 *
 * The token is re-verified here for the reason in this file's header: a server
 * action is a public endpoint, and the page's own check protects the page.
 *
 * ── THE CONSENT WORDING COMES FROM THE CALLER ────────────────────────────
 *
 * Deliberately, and it is the one input here that is not re-derived
 * server-side. What has to be recorded is what this person actually READ — and
 * the section could have been edited between the page loading and the form
 * being submitted, so reading the current wording out of the layout would
 * record words they were never shown.
 *
 * It is stored, never rendered as markup, and capped by `subscribe`, so a
 * forged value is a wrong line in the shop's own record rather than a risk to
 * anybody. A blank one falls back to the default (see DEFAULT_CONSENT_TEXT):
 * a row with no consent line is the one outcome 071 exists to prevent.
 */
export async function subscribeAction(
  token: string,
  input: { email: string; name?: string; consentText?: string; sourcePage?: string },
): Promise<SubscribeResult> {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return { ok: false, error: 'This shop is not available.' }

  // An OPEN shop only. A closed one serves nothing else, and a form kept open
  // across the moment it closed must not keep writing rows.
  const context = await storefrontContext(siteId)
  if (!context) return { ok: false, error: 'This shop is not available.' }

  return subscribe(siteId, {
    email: input.email,
    name: input.name ?? '',
    consentText: String(input.consentText ?? '').trim() || DEFAULT_CONSENT_TEXT,
    sourcePage: input.sourcePage ?? '',
  })
}
