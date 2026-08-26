import { NextResponse, type NextRequest } from 'next/server'
import { siteIdForCapability } from '@/lib/auth'
import { isOnSignInBoard } from '@/lib/site/posSignInSpecials'
import { getImage } from '@/lib/site/productImages'
import { readStoredFile, sniffImage, IMAGE_MIME } from '@/lib/uploads'

/**
 * A product photo for the till's sign-in board.
 *
 * ── WHY THIS EXISTS ALONGSIDE /api/product-images/[id] ───────────────────
 *
 * That route is gated on `products.view`, the capability that opens the product
 * screens. The audience here does not have it and should not: standing at a
 * till is not maintaining a product file. Pointed at the sibling route, the
 * board would show photographs to managers and blank squares to cashiers — the
 * same screen looking different depending on who happened to open the till that
 * morning, which is the bug this route exists to prevent.
 *
 * Lowering that route's gate is the wrong repair, for the reason
 * /api/department-image sets out at length: it addresses the image LIBRARY by
 * id, so a till operator could walk the ids and read every product photograph
 * the shop has. Two routes, two gates, neither able to become the other.
 *
 * ── WHY IT IS GATED ON THE BOARD, NOT JUST ON A CAPABILITY ───────────────
 *
 * This is what keeps `sales.till` honest. The product is checked against the
 * live sign-in board FIRST, before a byte is read, so the only pictures
 * reachable here are the ones already being displayed on a screen that faces
 * the shop floor. Enumerating this route yields the handful of items the shop
 * is currently advertising to the public — which is strictly less than the
 * caller can see by looking up from the counter.
 *
 * It also means the exposure shrinks by itself: when a promotion ends, its
 * photograph stops being reachable here without anybody changing a permission.
 *
 * The magic-byte check on the way out, `nosniff` and the sandbox CSP follow
 * /api/product-images for the reasons documented there.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  /* Checked here because api/ sits outside the (app) route group, so the
     layout's guard never runs for it and this URL is directly typeable. The
     site comes from the session, confining the whole read to one shop. */
  const siteId = await siteIdForCapability('sales.till')
  if (siteId === null) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }

  const imageId = Number(request.nextUrl.searchParams.get('id'))
  const productId = Number(request.nextUrl.searchParams.get('productId'))
  /* (id, productId) rather than id alone, exactly as the products route: an
     image id is a guessable integer, and requiring the caller to also name the
     product it hangs off turns a walked range into a 404. */
  if (!Number.isInteger(imageId) || imageId <= 0 || !Number.isInteger(productId) || productId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  /* THE REAL GATE. Resolved before the image is read, so a product that is not
     currently advertised is a 404 no matter what ids are supplied. */
  const advertised = await isOnSignInBoard(siteId, productId, new Date()).catch(() => false)
  if (!advertised) return new NextResponse('Not found', { status: 404 })

  const image = await getImage(siteId, productId, imageId)
  if (!image) return new NextResponse('Not found', { status: 404 })

  const bytes = await readStoredFile(image.storedName)
  if (!bytes) return new NextResponse('Not found', { status: 404 })

  const format = sniffImage(bytes)
  if (!format) {
    // The file on disk is not the image it claims to be. Refuse rather than
    // serve it — the case the whole design exists to prevent.
    return new NextResponse('Not found', { status: 404 })
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': IMAGE_MIME[format],
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      /* Private: behind a session, so it must never sit in a shared cache.
         Short, unlike the backdrop's hour: a promotion ending should stop
         showing its photograph within minutes rather than at the end of a
         cached hour, and this screen is repainted every time a cashier signs
         out anyway. */
      'cache-control': 'private, max-age=120',
    },
  })
}
