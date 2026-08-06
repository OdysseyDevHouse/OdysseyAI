import { notFound } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import {
  newestProducts,
  publishedDepartments,
  publishedProducts,
  storefrontContext,
  type StorefrontContext,
} from '@/lib/site/storefront'
import { getPublishedLayout, type HomeSection } from '@/lib/site/storefrontLayout'
import { EmptyState, Icons } from '@/components/ui'
import HomeSections, { type SectionContent } from './HomeSections'
import ProductGrid from './ProductGrid'
import StoreSearch from './StoreSearch'

/**
 * The shop's front page.
 *
 * Two modes. Browsing or searching shows a plain product list — that is what
 * the shopper asked for. Landing on the shop with no filters shows the page
 * the OWNER built, because a front page is a shop window and a wall of 40 000
 * products is not one.
 */

export const dynamic = 'force-dynamic'

/**
 * Fill each section with its data.
 *
 * One pass, in parallel: a page with four product rows should cost four
 * queries at once rather than four in sequence. Sections that need nothing
 * from the database resolve immediately.
 */
async function resolveSections(
  context: StorefrontContext,
  sections: HomeSection[],
): Promise<SectionContent[]> {
  return Promise.all(
    sections.map(async (section): Promise<SectionContent> => {
      if (section.kind === 'categories') {
        const all = await publishedDepartments(context)
        const max = section.maxItems ?? 0
        return { section, departments: max > 0 ? all.slice(0, max) : all }
      }

      if (section.kind === 'products') {
        const limit = section.maxItems ?? 8
        if (section.source === 'newest') {
          return { section, products: await newestProducts(context, limit) }
        }
        if (section.source === 'department' && section.departmentId) {
          return {
            section,
            products: await publishedProducts(context, {
              departmentId: section.departmentId,
              limit,
            }),
          }
        }
        // 'manual' with no picker yet, or a department that was never chosen.
        // Empty, which the renderer draws as nothing at all.
        return { section, products: [] }
      }

      return { section }
    }),
  )
}

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

  const departmentId = Number(query.department)
  const browsing = query.q?.trim() || (Number.isInteger(departmentId) && departmentId > 0)

  // Browsing or searching — a plain list of what matched.
  if (browsing) {
    const products = await publishedProducts(context, {
      departmentId: Number.isInteger(departmentId) && departmentId > 0 ? departmentId : undefined,
      search: query.q,
      limit: 120,
    })

    return (
      <div className="flex flex-col gap-5">
        <StoreSearch token={token} initial={query.q ?? ''} department={query.department} />
        {products.length === 0 ? (
          <EmptyState
            icon={<Icons.Package size={22} />}
            title={query.q ? `Nothing matching “${query.q}”` : 'Nothing in here yet'}
            hint="Try a different word, or browse the departments above."
          />
        ) : (
          <ProductGrid token={token} products={products} />
        )}
      </div>
    )
  }

  // The front page the owner built.
  const layout = await getPublishedLayout(siteId)
  const content = await resolveSections(context, layout.sections)
  const anythingToShow = content.some(
    ({ section, products, departments }) =>
      (section.kind === 'products' && (products?.length ?? 0) > 0) ||
      (section.kind === 'categories' && (departments?.length ?? 0) > 0) ||
      (section.kind === 'cards' && (section.cards ?? []).some((c) => c.heading || c.text)) ||
      (section.kind === 'hero' && (layout.theme.heroHeadline || layout.theme.heroSubtext)),
  )

  // A front page that would render nothing is worse than no front page: fall
  // back to the catalogue so a shopper always lands on something to buy.
  if (!anythingToShow) {
    const products = await publishedProducts(context, { limit: 120 })
    return (
      <div className="flex flex-col gap-5">
        <StoreSearch token={token} initial="" />
        {products.length === 0 ? (
          <EmptyState
            icon={<Icons.Package size={22} />}
            title="Nothing here yet"
            hint="This shop has not published anything to order online yet."
          />
        ) : (
          <ProductGrid token={token} products={products} />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <StoreSearch token={token} initial="" />
      <HomeSections token={token} content={content} theme={layout.theme} />
    </div>
  )
}
