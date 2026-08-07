import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import {
  publishedProducts,
  resolveSectionContent,
  storefrontContext,
} from '@/lib/site/storefront'
import { getPublishedLayout } from '@/lib/site/storefrontLayout'
import HomeSections, { type SectionContent } from './HomeSections'
import Catalogue from './Catalogue'

/**
 * The shop's front page.
 *
 * Two modes. Searching shows a plain product list — that is what the shopper
 * asked for. Landing on the shop with no search shows the page the OWNER
 * built, because a front page is a shop window and a wall of 40 000 products
 * is not one.
 */

export const dynamic = 'force-dynamic'

export default async function StorePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ department?: string; q?: string }>
}) {
  const { token } = await params
  const query = await searchParams

  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) notFound()
  const context = await storefrontContext(siteId)
  if (!context) notFound()

  const { settings } = context
  const departmentId = Number(query.department)
  const searching = Boolean(query.q?.trim())
  const browsing =
    searching || (Number.isInteger(departmentId) && departmentId > 0)

  const layout = await getPublishedLayout(siteId)

  // Searching or browsing — the catalogue, with its filters.
  if (browsing) {
    const products = await publishedProducts(context, {
      departmentId:
        Number.isInteger(departmentId) && departmentId > 0 ? departmentId : undefined,
      search: query.q,
      limit: 120,
    })

    return (
      <div className="flex flex-col gap-4">
        {searching && (
          <h1 className="text-xl font-semibold text-ink">
            Results for “{query.q?.trim()}”
          </h1>
        )}
        <Catalogue
          token={token}
          products={products}
          layout={layout.theme.productLayout}
          showStock={settings.showStock}
          showPhotos={settings.showPhotos}
          showBrands={settings.showBrands}
          query={query.q ?? ''}
        />
      </div>
    )
  }

  // The front page the owner built. The SAME resolver the builder uses, so
  // the preview cannot drift from the shop.
  const resolved = await resolveSectionContent(context, layout.sections)
  const content: SectionContent[] = layout.sections.map((section, i) => ({
    section,
    ...resolved[i],
  }))
  const anythingToShow = content.some(
    ({ section, products, departments, image }) =>
      (section.kind === 'products' && (products?.length ?? 0) > 0) ||
      (section.kind === 'categories' && (departments?.length ?? 0) > 0) ||
      (section.kind === 'cards' && (section.cards ?? []).some((c) => c.heading || c.text)) ||
      (section.kind === 'hero' && (layout.theme.heroHeadline || layout.theme.heroSubtext)) ||
      // Mirrors sectionBody: a banner with no picture and a paragraph with no
      // words both render nothing, and a page of only those must still fall
      // back to the catalogue rather than showing a blank shop.
      (section.kind === 'banner' && Boolean(image)) ||
      (section.kind === 'text' && Boolean(section.text?.trim() || section.title)),
  )

  // A front page that would render nothing is worse than no front page: fall
  // back to the catalogue so a shopper always lands on something to buy.
  if (!anythingToShow) {
    const products = await publishedProducts(context, { limit: 120 })
    return (
      <Catalogue
        token={token}
        products={products}
        layout={layout.theme.productLayout}
        showStock={settings.showStock}
        showPhotos={settings.showPhotos}
        showBrands={settings.showBrands}
        query=""
      />
    )
  }

  return (
    <HomeSections
      token={token}
      content={content}
      theme={layout.theme}
      display={{
        layout: layout.theme.productLayout,
        showStock: settings.showStock,
        showPhotos: settings.showPhotos,
        showBrands: settings.showBrands,
      }}
      // The PUBLIC route: it re-checks the store is open before serving a
      // byte. The builder passes the back-office one, which does not — see
      // ImageSrc on why that difference lives in the callers.
      imageSrc={(imageId) => `/api/store-images/${token}/shop/${imageId}`}
    />
  )
}
