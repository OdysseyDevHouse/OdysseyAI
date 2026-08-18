import { NextResponse } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { readLogo } from '@/lib/site/documentLogo'
import { IMAGE_MIME } from '@/lib/uploads'

/**
 * The business's logo, for the letterhead on a printed document.
 *
 * ── WHY THIS IS NOT GATED ON A CAPABILITY ─────────────────────────────────
 *
 * Every other image route asks for the permission that opens the screen the
 * picture belongs to. This one asks only that the caller is signed in to the
 * site, because the picture belongs to no screen: it is on the purchase order
 * a buyer prints, the invoice a clerk prints and the preview a designer looks
 * at. Gating it on setup.stationery would blank the logo on everyone's
 * paperwork except the person who uploaded it.
 *
 * That is not a weakening. A shop's own logo is the least secret thing it owns
 * — it is on every document that leaves the building — and the gate that
 * matters is still there: `requireSiteUser` resolves the site from the SESSION,
 * so the route cannot be pointed at another shop's file. There is no id in the
 * URL to tamper with.
 *
 * Checked here because api/ sits outside the (app) route group, so the layout's
 * guard never runs for it and this URL is directly typeable.
 *
 * The magic-byte check on the way out, `nosniff`, and the sandbox CSP follow
 * /api/product-images for the reasons documented there: what is served is
 * proved to be a picture, whatever is on disk.
 */

export const dynamic = 'force-dynamic'

export async function GET() {
  const { site } = await requireSiteUser()

  const logo = await readLogo(site.id)
  if (!logo) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: {
      'content-type': IMAGE_MIME[logo.format],
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Private: behind a session, so it must never sit in a shared cache.
      // The caller cache-busts with ?v=<stored name>, so an hour is safe.
      'cache-control': 'private, max-age=3600',
    },
  })
}
