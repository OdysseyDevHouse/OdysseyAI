import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteId } from '@/lib/auth'
import { getImage } from '@/lib/site/productImages'
import { readStoredFile, sniffImage, IMAGE_MIME } from '@/lib/uploads'

/**
 * Serves one product image to the BACK OFFICE.
 *
 * ── WHY THIS ONE RENDERS INLINE WHEN /api/documents DOES NOT ─────────────
 *
 * That route serves arbitrary uploads and forces a download, because rendering
 * an unknown file inline on our own origin is how a stored XSS gets in.
 *
 * An image has to render inline to be any use. The risk is answered a
 * different way: nothing reaches this table until `storeImageUpload` has read
 * its magic bytes and confirmed it is a real PNG/JPEG/GIF/WebP. An SVG or an
 * HTML page with a .png name never gets stored, so there is nothing here to
 * serve unsafely.
 *
 * The bytes are re-sniffed on the way OUT as well. Belt and braces: the file
 * could in principle have been replaced on disk since, and the Content-Type we
 * send is the one thing that decides whether a browser treats a response as a
 * picture or as a document. Deriving it from the bytes in hand — rather than
 * from the stored row — means the header can never disagree with reality.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Site comes from the session, so the whole read is confined to one site's
  // database before anything below runs.
  const siteId = await requireSiteId()
  const { id } = await params

  const imageId = Number(id)
  const productId = Number(request.nextUrl.searchParams.get('productId'))
  // (id, productId) rather than id alone, exactly as the documents route: an
  // image id is a guessable integer, and requiring the caller to also name the
  // product it hangs off turns a walked range into a 404.
  if (!Number.isInteger(imageId) || imageId <= 0 || !Number.isInteger(productId) || productId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const image = await getImage(siteId, productId, imageId)
  if (!image) return new NextResponse('Not found', { status: 404 })

  const bytes = await readStoredFile(image.storedName)
  if (!bytes) {
    return new NextResponse('This image is no longer on the server.', { status: 404 })
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
      // Never sniff past what we said. Without this a browser may decide a
      // response is HTML on the strength of its contents.
      'x-content-type-options': 'nosniff',
      // Belt and braces for the same reason as above: even if something were
      // served that could execute, this forbids it.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Private: this is behind a session, so it must not sit in a shared cache.
      'cache-control': 'private, max-age=3600',
    },
  })
}
