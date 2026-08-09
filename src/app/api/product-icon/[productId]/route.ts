import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { currentIcon } from '@/lib/site/productImages'
import { readStoredFile, sniffImage, IMAGE_MIME } from '@/lib/uploads'

/**
 * Serves a product's point-of-sale icon.
 *
 * A sibling of /api/product-images/[id] and deliberately not a special case of
 * it: that route addresses a row in product_images by id, and the icon is not a
 * row there — it is a stored name on the product itself. Keyed by productId for
 * the same reason: the product IS the identifier, there being exactly one icon.
 *
 * Every safety property of the sibling route applies here and for the same
 * reasons, so read that file's header for the full argument. In short: nothing
 * reaches image_icon until storeImageUpload has verified the magic bytes, and
 * the Content-Type sent below is derived from the bytes in hand rather than
 * from anything stored — so the header can never disagree with reality.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  // Site comes from the session, confining the read to one site's database.
  // Checked here because api/ sits outside the (app) route group, so the
  // layout's guard never runs for it. This URL is directly typeable.
  const siteId = await siteIdForCapability('products.view')
  if (siteId === null) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }

  const { productId: raw } = await params
  const productId = Number(raw)
  if (!Number.isInteger(productId) || productId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const storedName = await currentIcon(siteId, productId)
  if (!storedName) return new NextResponse('Not found', { status: 404 })

  const bytes = await readStoredFile(storedName)
  if (!bytes) {
    return new NextResponse('This icon is no longer on the server.', { status: 404 })
  }

  const format = sniffImage(bytes)
  if (!format) {
    // The file on disk is not the image it claims to be. Refuse rather than
    // serve it — this is the case the whole design exists to prevent.
    return new NextResponse('Not found', { status: 404 })
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': IMAGE_MIME[format],
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Private: this is behind a session, so it must not sit in a shared cache.
      // Short, because replacing an icon reuses this same URL — a long cache
      // would leave the old picture on screen after an upload.
      'cache-control': 'private, max-age=60',
    },
  })
}
