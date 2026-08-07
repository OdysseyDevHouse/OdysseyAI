import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { getStorefrontImage } from '@/lib/site/storefrontImages'
import { readStoredFile, sniffImage, IMAGE_MIME } from '@/lib/uploads'

/**
 * Serves a front-page banner to the BACK OFFICE.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE PUBLIC ROUTE ───────────────────────────
 *
 * The public one requires an open shop, which is exactly what the builder does
 * not have: building the front page before opening is the point of the draft.
 * An owner arranging banners on a closed shop would otherwise see a page of
 * broken pictures.
 *
 * A single route with a flag would put that difference behind a boolean, and a
 * boolean is one careless edit away from serving a closed shop's pictures to
 * the public. Two routes, two gates, neither able to become the other.
 *
 * The site comes from the session, so the whole read is confined to one site's
 * database before anything below runs. Checked here because api/ sits outside
 * the (app) route group, so the layout's guard never runs for it — this URL is
 * directly typeable.
 *
 * Inline rendering, magic-byte verification on the way out and the sandbox CSP
 * all follow /api/product-images for the reasons documented there.
 */

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // The same capability that opens the builder. Anyone who may arrange the
  // front page may look at the pictures on it.
  const siteId = await siteIdForCapability('online.edit')
  if (siteId === null) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }

  const { id } = await params
  const imageId = Number(id)
  if (!Number.isInteger(imageId) || imageId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const image = await getStorefrontImage(siteId, imageId)
  if (!image) return new NextResponse('Not found', { status: 404 })

  const bytes = await readStoredFile(image.storedName)
  if (!bytes) {
    return new NextResponse('This picture is no longer on the server.', { status: 404 })
  }

  const format = sniffImage(bytes)
  if (!format) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': IMAGE_MIME[format],
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Private: this is behind a session, so it must not sit in a shared cache.
      'cache-control': 'private, max-age=3600',
    },
  })
}
