'use client'

import { useEffect } from 'react'
import { SHOP_SESSION_COOKIE, SHOP_SESSION_MAX_AGE, isShopSessionKey } from '@/lib/shopSession'

/**
 * Mints the storefront's analytics session id, once per browser session.
 *
 * ── WHY THE BROWSER AND NOT THE SERVER ───────────────────────────────────
 *
 * A Next layout may not set a cookie — only a route handler, an action or the
 * proxy can — and none of those runs on a plain page view. Writing it here
 * costs one line of script and keeps the id out of the request path entirely.
 *
 * ── WHY IT IS NOT httpOnly ───────────────────────────────────────────────
 *
 * Because it protects nothing. It is a random number whose only power is to
 * join one page view to another; there is no account behind it, no session to
 * hijack, and nothing an attacker gains by reading or forging one but a
 * slightly wrong funnel. Marking it httpOnly would imply a value it does not
 * have.
 *
 * SameSite=Lax and no Secure flag, so it works on a shop served over plain
 * http on a shop-floor tablet.
 */
export default function ShopSession() {
  useEffect(() => {
    const existing = document.cookie
      .split('; ')
      .find((row) => row.startsWith(`${SHOP_SESSION_COOKIE}=`))
      ?.split('=')[1]

    // Re-minted when it is missing OR malformed. A junk value would be dropped
    // by the recorder anyway, so leaving one in place would silently stop
    // measuring this shopper for the rest of their visit.
    if (existing && isShopSessionKey(existing)) return

    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

    document.cookie =
      `${SHOP_SESSION_COOKIE}=${key}; path=/; max-age=${SHOP_SESSION_MAX_AGE}; samesite=lax`
  }, [])

  return null
}
