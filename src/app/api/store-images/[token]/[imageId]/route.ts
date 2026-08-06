import { NextResponse, type NextRequest } from 'next/server'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { publishedProduct, storefrontContext } from '@/lib/site/storefront'
import { getImage } from '@/lib/site/productImages'
import { readStoredFile, sniffImage, IMAGE_MIME } from '@/lib/uploads'

/**
 * Serves a product image to the PUBLIC storefront.
 *
 * ── THE PUBLISH RULE APPLIES TO PICTURES TOO ─────────────────────────────
 *
 * A separate route from the back office one, not a shared handler with a flag.
 * This one resolves the store from its signed token and then asks
 * `publishedProduct` whether that product is actually on sale — so the image
 * of an unpublished product 404s even when its id is guessed, exactly as the
 * product page does.
 *
 * Sharing one route between an authenticated and an anonymous caller would put
 * that check behind a boolean, and a boolean is one careless edit away from
 * being wrong in the direction that leaks the whole catalogue.
 *
 * Everything else — magic-byte verification on the way out, a Content-Type
 * derived from the bytes, nosniff, a sandbox CSP — matches the back office
 * route and exists for the same reason.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; imageId: string }> },
) {
  const { token, imageId: rawImageId } = await params

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return new NextResponse('Not found', { status: 404 })

  const context = await storefrontContext(siteId)
  // A closed shop serves no pictures either.
  if (!context) return new NextResponse('Not found', { status: 404 })

  const imageId = Number(rawImageId)
  const productId = Number(request.nextUrl.searchParams.get('p'))
  if (!Number.isInteger(imageId) || imageId <= 0 || !Number.isInteger(productId) || productId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  // The publish rule. Without this, every product photograph in the file would
  // be readable by anyone holding the shop link, whatever the shop chose to
  // put on sale.
  const product = await publishedProduct(context, productId)
  if (!product) return new NextResponse('Not found', { status: 404 })

  const image = await getImage(siteId, productId, imageId)
  if (!image) return new NextResponse('Not found', { status: 404 })

  const bytes = await readStoredFile(image.storedName)
  if (!bytes) return new NextResponse('Not found', { status: 404 })

  const format = sniffImage(bytes)
  if (!format) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': IMAGE_MIME[format],
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Public and long-lived: a product photo is the same for every shopper,
      // it changes rarely, and every uncached hit is a database round trip plus
      // a disk read on a page that shows sixty of them. `immutable` is safe
      // because a replaced image gets a new id and therefore a new URL.
      'cache-control': 'public, max-age=86400, immutable',
    },
  })
}
