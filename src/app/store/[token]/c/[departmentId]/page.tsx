import { redirect } from 'next/navigation'
import Link from 'next/link'
import Pager from '../../Pager'
import type { Metadata } from 'next'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { resolveStorefront } from '@/lib/storeRouting'
import {
  catalogueFacets,
  publishedDepartments,
  publishedProducts,
  publishedProductsCount,
  safeSort,
  resolveSectionContent,
  storefrontContext,
} from '@/lib/site/storefront'
import { getPublishedLayout } from '@/lib/site/storefrontLayout'
import {
  departmentPage,
  departmentPageFor,
  getPageSectionsFor,
  getPublishedPageLayout,
} from '@/lib/site/storefrontPages'
import { verifyPreviewToken } from '@/lib/previewToken'
import { Icons } from '@/components/ui'
import HomeSections, { type SectionContent } from '../../HomeSections'
import PreviewBar from '../../PreviewBar'
import CategoryBrowser from './CategoryBrowser'
import FacetBar, { priceBands } from './FacetBar'
import SortBar from './SortBar'

/**
 * One department.
 *
 * ── KEYED ON ID, NEVER NAME ──────────────────────────────────────────────
 *
 * Department names contain slashes, ampersands and apostrophes, and they get
 * renamed. A link a shopper saved or a shop put on a poster must keep working
 * through a rename, which a name-keyed URL cannot do.
 *
 * ── A DEPARTMENT NOBODY PUBLISHES LOOKS LIKE ONE THAT NEVER EXISTED ──────
 *
 * Same message either way, deliberately. Distinguishing them would let anyone
 * enumerate which departments a shop has but keeps private.
 */

export const dynamic = 'force-dynamic'

/** Enough to browse without paging; far short of rendering a 900-product wall. */
/**
 * Products per page.
 *
 * A PAGE size now, not a ceiling. This was 120 with a footnote telling the
 * shopper to search — which meant a department of 400 showed 120 of them,
 * alphabetically, with no way to reach the rest. 24 fills a grid evenly at
 * every column count the theme offers (2, 3, 4, 5 and 6 all divide it or
 * leave one short row), and the pager below reaches everything.
 */
const PER_PAGE = 24

async function resolve(token: string, departmentId: string) {
  const resolved = await resolveStorefront(token)
  if (!resolved) return null
  const { context } = resolved

  const id = Number(departmentId)
  if (!Number.isInteger(id) || id <= 0) return null

  // Must be a department the shop actually publishes — not merely one that
  // exists. `publishedDepartments` already applies the publish rules.
  const department = (await publishedDepartments(context)).find((d) => d.id === id)
  if (!department) return null

  return { context, department }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string; departmentId: string }>
}): Promise<Metadata> {
  const { token, departmentId } = await params
  const found = await resolve(token, departmentId)
  if (!found) return { title: 'Not found', robots: { index: false, follow: false } }

  const { context, department } = found
  /*
   * The department's page may carry its own words. Only a PUBLISHED one:
   * metadata is what a link looks like when shared, and a draft is not a thing
   * to share — the same rule the standard-page route follows, and the reason
   * no preview pass is read here.
   *
   * ── SEO DOES NOT INHERIT ─────────────────────────────────────────────────
   *
   * `departmentPage`, not `departmentPageFor`: an inherited page lends its
   * SECTIONS, never its words. One title and description repeated across forty
   * sub-departments is duplicate content — every aisle claiming to be the same
   * page — and a shopper who shares a link to "Wine › Red" should see Red in
   * the card, not whatever the parent was called. So a department with no page
   * of its own falls back to its own name here, as it always did.
   */
  const page = await departmentPage(context.siteId, department.id)
  const seo = page?.isPublished ? page : null

  const title = seo?.seoTitle.trim() || `${department.name} · ${context.storeName}`
  const description =
    seo?.seoDescription.trim() ||
    context.settings.blurb ||
    `${department.name} — ${context.storeName}`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'article',
      // The public image route, which re-checks the store is open before
      // serving a byte — the same one the sections themselves use.
      ...(seo?.seoImageId
        ? { images: [{ url: `/api/store-images/${token}/shop/${seo.seoImageId}` }] }
        : {}),
    },
    robots: { index: false, follow: false },
  }
}

export default async function DepartmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; departmentId: string }>
  searchParams: Promise<{
    q?: string
    preview?: string
    brand?: string
    min?: string
    max?: string
    band?: string
    page?: string
    sort?: string
  }>
}) {
  const { token, departmentId } = await params
  const { q, preview: previewToken, brand, min, max, band, page: pageParam, sort: sortParam } =
    await searchParams
  const found = await resolve(token, departmentId)

  /*
   * Rendered inline rather than notFound(). A not-found boundary would lose
   * the shop's own chrome, and a shopper who mistypes a link should land in
   * the shop they were heading for, not on a bare error page.
   */
  if (!found) {
    return (
      <div className="py-10 text-center">
        <h1 className="text-lg font-semibold text-ink">We couldn&rsquo;t find that department</h1>
        <p className="mt-2 text-sm text-muted">
          It may have been taken off the online store.
        </p>
        <Link
          href={`/store/${token}`}
          className="mt-5 inline-block text-sm font-medium text-brand hover:underline"
        >
          Browse everything
        </Link>
      </div>
    )
  }

  const { context, department } = found
  // The grid/list choice lives on the THEME, with the rest of the shop's
  // appearance — it is a look, not a rule about what may be sold.
  const activeBrand = brand?.trim() ?? ''
  const minPriceIncl = Number(min) > 0 ? Number(min) : undefined
  const maxPriceIncl = Number(max) > 0 ? Number(max) : undefined

  /*
   * The page number, and the order.
   *
   * Both come from the URL rather than from state, so a filtered page can be
   * shared, bookmarked and crawled — the same reasoning FacetBar already
   * gives for being links. A junk page number reads as page 1 instead of
   * throwing: these arrive from stale links and search-engine probes.
   */
  const sort = safeSort(sortParam)
  const requested = Math.floor(Number(pageParam))
  const pageNumber = Number.isFinite(requested) && requested > 1 ? requested : 1
  const offset = (pageNumber - 1) * PER_PAGE

  const [products, total, layout, found2, facets] = await Promise.all([
    publishedProducts(context, {
      departmentId: department.id,
      limit: PER_PAGE,
      offset,
      sort,
      brand: activeBrand || undefined,
      minPriceIncl,
      maxPriceIncl,
    }),
    // The same filter, so the pager can never promise a page the grid
    // cannot fill — see publishedProductsCount.
    publishedProductsCount(context, {
      departmentId: department.id,
      brand: activeBrand || undefined,
      minPriceIncl,
      maxPriceIncl,
    }),
    getPublishedLayout(context.siteId),
    // Its own page, or the nearest ancestor's that offered itself. A department
    // with neither still gets null and renders exactly as it always has.
    departmentPageFor(context.siteId, department.id),
    catalogueFacets(context, department.id).catch(() => null),
  ])
  /*
   * A page past the end goes back to the last real one.
   *
   * Reachable from a stale bookmark, from a crawler that kept an old link,
   * and from anybody editing the number by hand — and left alone it renders
   * an empty grid under a pager reading "Showing 3993–14 of 14", which is
   * the shop looking broken over a typo. A redirect rather than a clamp so
   * there is ONE address per page: rendering page 3 at ?page=999 would be a
   * second URL for the same content, which is a duplicate a search engine
   * has to be told about.
   */
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE))
  if (pageNumber > lastPage) {
    const next = new URLSearchParams()
    for (const [key, value] of Object.entries({ q, brand, min, max, band, sort: sortParam })) {
      if (value) next.set(key, value)
    }
    if (lastPage > 1) next.set('page', String(lastPage))
    const qs = next.toString()
    redirect(`/store/${token}/c/${department.id}${qs ? `?${qs}` : ''}`)
  }

  const page = found2?.page ?? null

  /*
   * The department's OWN sections, if the owner built any.
   *
   * ── ABSENT MEANS UNCHANGED ───────────────────────────────────────────────
   *
   * Almost no department has a page, and the ones that do not must render
   * exactly as they always have. So this resolves to an empty array and draws
   * nothing rather than to some default arrangement — a department that grew
   * three sections nobody asked for is a worse outcome than one with none.
   *
   * Above the products, not below: a banner explaining the aisle is a thing
   * you read before choosing, and a shopper who has already started scrolling
   * the grid has made their choice.
   */
  const preview = previewToken ? await verifyPreviewToken(previewToken) : null
  /*
   * A preview pass can see this department's draft even when the page is
   * switched off — that is the case it exists for. Without one, an unpublished
   * department page renders nothing, exactly as before.
   *
   * An INHERITED page is never previewed here, only published. The draft on a
   * parent belongs to the parent's own preview; showing it on a child would
   * present work-in-progress as that child's settled appearance, on a page the
   * owner did not open. `departmentPageFor` only lends published pages, so this
   * branch is already the published one — stated rather than implied, because
   * the alternative is a leak nobody would notice.
   */
  const shown = page
    ? preview && !found2?.inherited
      ? await getPageSectionsFor(context.siteId, page.id, preview)
      : page.isPublished
        ? { sections: await getPublishedPageLayout(context.siteId, page.id), isPreview: false }
        : { sections: [], isPreview: false }
    : { sections: [], isPreview: false }

  const sections = shown.sections
  /*
   * Anchored to THIS department, with no product — so a "More in this
   * department" row follows the page it is on rather than a department id
   * frozen into the layout when it was built. id 0 because there is no product
   * to exclude; see `resolveSectionContent`.
   */
  const resolved = sections.length
    ? await resolveSectionContent(context, sections, { id: 0, departmentId: department.id })
    : []
  const content: SectionContent[] = sections.map((section, i) => ({ section, ...resolved[i] }))

  return (
    <div>
      {shown.isPreview && page && (
        <PreviewBar builderHref={`/online-store/builder?page=${page.id}`} />
      )}
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm">
        <Link href={`/store/${token}`} className="font-medium text-brand hover:underline">
          All products
        </Link>
        <Icons.ChevronRight size={14} className="shrink-0 text-muted" aria-hidden />
        <span aria-current="page" className="text-ink">
          {department.name}
        </span>
      </nav>

      <h1 className="mt-2 text-xl font-semibold text-ink">{department.name}</h1>

      {facets && (
        <FacetBar
          basePath={`/store/${token}/c/${department.id}`}
          q={q ?? ''}
          brands={facets.brands}
          activeBrand={activeBrand}
          bands={priceBands(facets.minPrice, facets.maxPrice)}
          activeBand={Number.isInteger(Number(band)) && Number(band) >= 0 ? Number(band) : -1}
        />
      )}

      {/* Only where there is something to reorder. One product in an aisle
          does not need four ways to arrange it. */}
      {total > 1 && (
        <SortBar
          basePath={`/store/${token}/c/${department.id}`}
          active={sort}
          params={{ q, brand, min, max, band }}
        />
      )}

      {content.length > 0 && (
        <div className="mt-4">
          <HomeSections
            token={token}
            content={content}
            theme={layout.theme}
            display={{
              layout: layout.theme.productLayout,
              showStock: context.settings.showStock,
              showPhotos: context.settings.showPhotos,
              showBrands: context.settings.showBrands,
              showDepartmentImages: context.settings.showDepartmentImages,
            }}
            imageSrc={(imageId) => `/api/store-images/${token}/shop/${imageId}`}
          />
        </div>
      )}

      <CategoryBrowser
        token={token}
        departmentName={department.name}
        products={products}
        layout={layout.theme.productLayout}
        showStock={context.settings.showStock}
        showPhotos={context.settings.showPhotos}
        showBrands={context.settings.showBrands}
        initialQuery={q ?? ''}
      />

      <Pager
        page={pageNumber}
        perPage={PER_PAGE}
        total={total}
        basePath={`/store/${token}/c/${department.id}`}
        // Everything else the URL is carrying, so paging keeps the filters
        // rather than dropping a shopper back into the unfiltered aisle.
        params={{ q, brand, min, max, band, sort: sortParam }}
      />
    </div>
  )
}
