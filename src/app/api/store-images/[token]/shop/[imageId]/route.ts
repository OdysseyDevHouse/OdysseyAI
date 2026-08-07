import { NextResponse, type NextRequest } from 'next/server'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext } from '@/lib/site/storefront'
import { getStorefrontImage } from '@/lib/site/storefrontImages'
import { readStoredFile, sniffImage, IMAGE_MIME } from '@/lib/uploads'

/**
 * Serves one of the SHOP's own pictures to the PUBLIC storefront — a front-page
 * banner or the masthead logo.
 *
 * Named `shop` rather than `banner` because both come out of one library and
 * one table; a path saying "banner" that also serves the logo is a name that
 * has to be explained every time it is read.
 *
 * ── WHY THERE IS NO PUBLISH CHECK HERE ───────────────────────────────────
 *
 * The sibling route serving product photographs asks `publishedProduct`
 * whether that product is actually on sale, because a product image is only as
 * public as its product.
 *
 * These have no such owner. They are pictures the shop deliberately put on its
 * own pages — the most public things it has. The gate that matters is the one
 * this route does apply: the signed store token must resolve, and
 * `storefrontContext` must agree the shop is open. A closed shop serves none of
 * them, exactly as it serves no products and no pictures of them.
 *
 * Everything else — magic-byte verification on the way out, a Content-Type
 * derived from the bytes rather than the stored row, nosniff, a sandbox CSP —
 * matches the other image routes and exists for the same reasons.
 *
 * Sitting under /api/store-images/ is deliberate: proxy.ts already treats that
 * prefix as public, so a banner cannot be accidentally left behind a login
 * redirect that would show every shopper a broken image.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string; imageId: string }> },
) {
  const { token, imageId: rawImageId } = await params

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return new NextResponse('Not found', { status: 404 })

  // A closed shop serves no pictures either — and a bad token and an off store
  // stay deliberately indistinguishable from outside.
  const context = await storefrontContext(siteId)
  if (!context) return new NextResponse('Not found', { status: 404 })

  const imageId = Number(rawImageId)
  if (!Number.isInteger(imageId) || imageId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  // Scoped to this site's own database, so one shop's id can never resolve to
  // another shop's picture.
  const image = await getStorefrontImage(siteId, imageId)
  if (!image) return new NextResponse('Not found', { status: 404 })

  const bytes = await readStoredFile(image.storedName)
  if (!bytes) return new NextResponse('Not found', { status: 404 })

  const format = sniffImage(bytes)
  // The file on disk is not the image it claims to be. Refuse rather than
  // serve it — this is the case the whole design exists to prevent.
  if (!format) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': IMAGE_MIME[format],
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Public and long-lived, as the product route: a banner is the same for
      // every shopper and it sits at the top of the page, so an uncached hit is
      // a database round trip plus a disk read before anything renders.
      // `immutable` is safe because a replaced picture gets a new id and
      // therefore a new URL.
      'cache-control': 'public, max-age=86400, immutable',
    },
  })
}
