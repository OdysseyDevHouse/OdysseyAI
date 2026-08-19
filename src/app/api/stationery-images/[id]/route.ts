import { NextResponse } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { readImage } from '@/lib/site/stationeryImages'
import { IMAGE_MIME } from '@/lib/uploads'

/**
 * One of the shop's document pictures.
 *
 * ── WHY THE SITE IS NEVER IN THE URL ──────────────────────────────────────
 *
 * `requireSiteUser` resolves the site from the SESSION, and readImage is scoped
 * to that site's own database — so the id in the path can only ever reach a
 * picture belonging to the shop the caller is signed in to. Walking the range
 * finds other pictures of their own, which they may see anyway, and nothing
 * else.
 *
 * ── AND WHY NOT A CAPABILITY ──────────────────────────────────────────────
 *
 * The same reasoning /api/document-logo sets out. These pictures are ON the
 * invoice a clerk prints and the purchase order a buyer prints; gating them on
 * setup.stationery would blank them for everyone except the person who
 * uploaded them. What the shop chose to put on documents that leave the
 * building is not a secret from the shop's own staff.
 *
 * Checked here because api/ sits outside the (app) route group, so the layout's
 * guard never runs and this URL is directly typeable.
 *
 * The magic-byte check on the way out, `nosniff` and the sandbox CSP follow
 * /api/product-images for the reasons documented there: what is served is
 * proved to be a picture, whatever happens to be on disk.
 */

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { site } = await requireSiteUser()
  const { id } = await params

  const imageId = Number(id)
  if (!Number.isInteger(imageId) || imageId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const image = await readImage(site.id, imageId)
  if (!image) return new NextResponse('Not found', { status: 404 })

  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      'content-type': IMAGE_MIME[image.format],
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Private: behind a session, so it must never sit in a shared cache. The
      // id is stable and the bytes never change under it — a replaced picture
      // is a new row — so an hour is safe without cache-busting.
      'cache-control': 'private, max-age=3600',
    },
  })
}
