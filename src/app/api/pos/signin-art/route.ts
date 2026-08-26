import { NextResponse } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { readBackdrop } from '@/lib/site/posSignInArt'
import { IMAGE_MIME } from '@/lib/uploads'

/**
 * The picture behind the till's sign-in screen.
 *
 * ── WHY THIS IS NOT GATED ON A CAPABILITY ─────────────────────────────────
 *
 * The same reasoning /api/document-logo gives, and for a closer reason. This
 * picture belongs to no screen a permission opens — it is the wallpaper on the
 * one screen in the product that is looked at by people who have no account at
 * all, from the customer side of the counter. Gating it would blank it for
 * exactly the audience it was uploaded for.
 *
 * That is not a weakening. The gate that matters is still here:
 * `requireSiteUser` resolves the site from the SESSION, so the route cannot be
 * pointed at another shop's file, and there is no id in the URL to tamper with.
 * A shop's own shopfront photograph is the least secret thing it owns.
 *
 * Checked here because api/ sits outside the (app) route group, so the layout's
 * guard never runs for it and this URL is directly typeable.
 *
 * The magic-byte check on the way out, `nosniff`, and the sandbox CSP follow
 * /api/product-images for the reasons documented there: what is served is proved
 * to be a picture, whatever happens to be on disk.
 */

export const dynamic = 'force-dynamic'

export async function GET() {
  const { site } = await requireSiteUser()

  const art = await readBackdrop(site.id)
  /* 404 rather than a placeholder: no picture is the NORMAL state, and the gate
     already paints its gradient when the URL is absent. Serving stand-in bytes
     would make "no backdrop" indistinguishable from "backdrop failed to load"
     at the one place that difference could be acted on. */
  if (!art) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(new Uint8Array(art.bytes), {
    headers: {
      'content-type': IMAGE_MIME[art.format],
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Private: behind a session, so it must never sit in a shared cache.
      // The caller cache-busts with ?v=<stored name>, so an hour is safe.
      'cache-control': 'private, max-age=3600',
    },
  })
}
