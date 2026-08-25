import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getDepartment } from '@/lib/site/departments'
import { getStorefrontImage } from '@/lib/site/storefrontImages'
import { readStoredFile, sniffImage, IMAGE_MIME } from '@/lib/uploads'

/**
 * Serves a department's till picture — to the point of sale, and to the screens
 * that arrange what the point of sale shows.
 *
 * ── WHY THIS EXISTS ALONGSIDE /api/storefront-images/[id] ────────────────
 *
 * That route is gated on `online.edit`, the capability that opens the shop
 * builder. Neither audience here has it, and neither should: standing at a till
 * is not arranging an online shop, and nor is laying out the till's menu.
 * Pointed at the sibling route, every department tile would render a broken
 * image for exactly the people the pictures were uploaded for.
 *
 * Lowering that route's gate is the wrong repair. It addresses the picture
 * LIBRARY by id, so a till operator could walk the ids and read every banner,
 * logo and unused draft the shop has ever uploaded. Two routes, two gates,
 * neither able to become the other — the argument that route makes for its own
 * existence, applied once more.
 *
 * ── WHY IT IS KEYED BY DEPARTMENT, NOT BY PICTURE ────────────────────────
 *
 * This is what keeps the wider gate honest. The department is resolved FIRST and
 * the picture id is read off it, so the only pictures reachable here are the ones
 * a department actually points at. The id in the URL is never treated as a
 * picture id — it names a department, and a department names at most one till
 * picture. Enumerating this route enumerates departments, which every caller
 * below already holds in full.
 *
 * ── WHY THREE CAPABILITIES ──────────────────────────────────────────────
 *
 * The same picture, drawn by three screens with three different jobs, and no one
 * capability covers them:
 *
 *   sales.till    the cashier, who sees it on the rail and on the tile
 *   setup.edit    the menu designer, which promises "what a cashier sees" and
 *                 would be lying if it drew a glyph where the till draws a picture
 *   products.view the department screens, where the picture is being chosen
 *
 * Any ONE of them is enough, because all three are already trusted with the
 * department list itself — and this route hands back strictly less than that: one
 * picture belonging to one department the caller can already name.
 */

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ departmentId: string }> },
) {
  // Checked here because api/ sits outside the (app) route group, so the
  // layout's guard never runs for it. This URL is directly typeable. The site
  // comes from the session, confining the read to one site's database.
  const { site, capabilities } = await requireSiteUser()
  const allowed =
    can(capabilities, 'sales.till') ||
    can(capabilities, 'setup.edit') ||
    can(capabilities, 'products.view')
  if (!allowed) return new NextResponse('Not allowed', { status: 403 })

  const { departmentId: raw } = await params
  const departmentId = Number(raw)
  if (!Number.isInteger(departmentId) || departmentId <= 0) {
    return new NextResponse('Not found', { status: 404 })
  }

  const department = await getDepartment(site.id, departmentId)
  if (!department?.posImageId) return new NextResponse('Not found', { status: 404 })

  /* A dangling id is not an error — 064 is explicit that every reader resolves a
     missing picture to null and falls back to the colour and the glyph. A 404 IS
     that fallback here: the tile's <img> fails and the caller has already drawn
     the toned disc underneath it. */
  const image = await getStorefrontImage(site.id, department.posImageId)
  if (!image) return new NextResponse('Not found', { status: 404 })

  const bytes = await readStoredFile(image.storedName)
  if (!bytes) {
    return new NextResponse('This picture is no longer on the server.', { status: 404 })
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
      /* Private: this is behind a session, so it must not sit in a shared cache.
         An hour rather than the product icon's minute — a till redraws this grid
         all shift long and a department picture changes about never. Being an
         hour stale on a picture nobody has changed costs nothing; re-fetching
         every tile on every drill is a flicker a cashier would see. */
      'cache-control': 'private, max-age=3600',
    },
  })
}
