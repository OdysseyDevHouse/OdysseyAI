import { NextResponse } from 'next/server'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { storefrontContext, publishedProducts, publishedDepartments } from '@/lib/site/storefront'
import { storefrontUrl } from '@/lib/site/storefrontSeo'

/**
 * The shop's sitemap.
 *
 * ── IT 404s UNLESS THE SHOP HAS OPTED IN ─────────────────────────────────
 *
 * A sitemap is an invitation to crawl. Serving one for a shop that has chosen
 * not to be indexed would hand a crawler the whole catalogue, along with the
 * signed store token in every URL — undoing the opt-out in the one file whose
 * entire job is to be read by robots.
 *
 * ── ONE FILE, NOT AN INDEX ───────────────────────────────────────────────
 *
 * The 50,000-URL limit is not close for a corner shop, and a sitemap index
 * doubles the number of things that have to be right. Capped anyway, and the
 * cap is announced in a comment inside the XML rather than silently truncating
 * — a shop past it should be able to find out why.
 */

export const dynamic = 'force-dynamic'

/** Well under the 50,000-URL protocol limit, and a sane query for a shop. */
const MAX_URLS = 5000

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return notFound()

  const context = await storefrontContext(siteId)
  if (!context) return notFound()

  // The opt-out is the whole point — see above.
  if (!context.settings.allowIndexing) return notFound()

  const base = `/store/${token}`
  const home = storefrontUrl(context.settings, base)
  // With no domain and no APP_URL there is no absolute address to publish, and
  // a sitemap of relative URLs is invalid rather than merely unhelpful.
  if (!home) return notFound()

  const [departments, products] = await Promise.all([
    publishedDepartments(context).catch(() => []),
    publishedProducts(context, { limit: MAX_URLS }).catch(() => []),
  ])

  const urls: { loc: string; priority: string }[] = [{ loc: home, priority: '1.0' }]

  for (const department of departments) {
    const loc = storefrontUrl(context.settings, `${base}/c/${department.id}`)
    if (loc) urls.push({ loc, priority: '0.7' })
  }

  /*
   * A variant group contributes ONE url, not one per size.
   *
   * publishedProducts returns every sellable child, so a shirt in five sizes
   * would otherwise be five near-identical pages competing with each other in
   * search — which is exactly the duplicate-content problem the canonical tag
   * on the product page exists to solve. Listing the group's representative
   * once says the same thing more cheaply.
   */
  const seenGroups = new Set<number>()
  for (const product of products) {
    const group = product.variantOf?.parentId ?? null
    if (group !== null) {
      if (seenGroups.has(group)) continue
      seenGroups.add(group)
    }
    const loc = storefrontUrl(context.settings, `${base}/p/${product.id}`)
    if (loc) urls.push({ loc, priority: '0.5' })
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
${products.length >= MAX_URLS ? `<!-- Capped at ${MAX_URLS} products. -->\n` : ''}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((u) => `  <url><loc>${escapeXml(u.loc)}</loc><priority>${u.priority}</priority></url>`)
  .join('\n')}
</urlset>`

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // Crawlers re-fetch this often and a catalogue does not change by the
      // minute. Cheap for us, and no staler than a crawl schedule anyway.
      'Cache-Control': 'public, max-age=3600',
    },
  })
}

function notFound() {
  return new NextResponse('Not found', { status: 404 })
}

/** The five characters that cannot appear raw in XML text. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
