import { NextResponse } from 'next/server'
import { verifyPortalToken } from '@/lib/publicPortalToken'
import { portalSettings, portalIsOpen } from '@/lib/site/portalAuth'
import { readLogo } from '@/lib/site/documentLogo'
import { IMAGE_MIME } from '@/lib/uploads'

/**
 * The business's logo, for the portal letterhead.
 *
 * ── WHY NOT /api/document-logo ─────────────────────────────────────────────
 *
 * That route resolves the site from a STAFF session, which a customer does not
 * have — so it would 401 on every portal page. It cannot simply be opened up
 * either: with no id in its URL it depends on the session to know which shop is
 * being asked about, and there is nothing else for it to read.
 *
 * Here the SIGNED TOKEN in the path names the site, exactly as it does for
 * every other portal route. Same guarantee, different key.
 *
 * ── IT NEEDS NO CUSTOMER SESSION ───────────────────────────────────────────
 *
 * Deliberately, because the sign-in page shows the logo too — and gating it
 * would mean a portal whose letterhead only appears after signing in.
 *
 * A shop's logo is the least secret thing it owns: it is on every invoice,
 * statement and order that leaves the building, and on the storefront. What
 * this must not do is answer for a shop that has not opened a portal at all,
 * which is why the settings are still checked — a closed portal serves nothing.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const siteId = await verifyPortalToken(token)
  if (siteId === null) return new NextResponse('Not found', { status: 404 })

  const settings = await portalSettings(siteId)
  if (!portalIsOpen(settings)) return new NextResponse('Not found', { status: 404 })

  const logo = await readLogo(siteId)
  // No logo is the ordinary case, not an error — the header falls back to the
  // business name on its own.
  if (!logo) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: {
      'content-type': IMAGE_MIME[logo.format],
      // Proved to be a picture on the way out, and sandboxed — the same
      // treatment /api/document-logo gives it, for the same reasons.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      /*
       * PUBLIC, unlike the staff route's `private`. There is no session here to
       * leak between, the picture is the same for every viewer of this shop,
       * and it is fetched on every page load — so letting a CDN or a browser
       * hold it is the whole point. The caller cache-busts with ?v=<name>.
       */
      'cache-control': 'public, max-age=3600',
    },
  })
}
