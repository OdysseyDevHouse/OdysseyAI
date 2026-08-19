import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { resolveStorefront } from '@/lib/storeRouting'
import { bestSellerIds } from '@/lib/site/storefront'
import { getPublishedLayout } from '@/lib/site/storefrontLayout'
import {
  collectionBySlug,
  collectionProducts,
} from '@/lib/site/storefrontCollections'
import { getPublishedPageLayout } from '@/lib/site/storefrontPages'
import { catalogueRobots, storefrontUrl } from '@/lib/site/storefrontSeo'
import { listingPresetFor, shopBadgeRules } from '@/lib/site/listingPresets'
import { resolvePageContent } from '@/lib/site/storefront'
import HomeSections, { type SectionContent } from '../../HomeSections'
import ProductGrid from '../../ProductGrid'
import Pager from '../../Pager'

/**
 * One collection.
 *
 * ── KEYED ON A SLUG, UNLIKE A DEPARTMENT ─────────────────────────────────
 *
 * A department is reached by id because it is an internal tree that happens to
 * be browsable, and its NAME changes. A collection is the opposite: it exists
 * to be shared — in a message, on a poster, in a post — so its address is the
 * readable thing a merchant chose, and renaming the title deliberately leaves
 * the address alone.
 *
 * ── A COLLECTION NOBODY PUBLISHES LOOKS LIKE ONE THAT NEVER EXISTED ──────
 *
 * `collectionBySlug` returns null for an unpublished one, and this renders the
 * same nothing either way. Distinguishing them would let anyone enumerate what
 * a shop is planning.
 */

export const dynamic = 'force-dynamic'

async function resolve(token: string, slug: string) {
  const resolved = await resolveStorefront(token)
  if (!resolved) return null
  const { context } = resolved
  const collection = await collectionBySlug(context.catalogueSiteId, slug)
  if (!collection) return null
  return { context, collection }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string; slug: string }>
}): Promise<Metadata> {
  const { token, slug } = await params
  const found = await resolve(token, slug)
  if (!found) return { title: 'Not found', robots: { index: false, follow: false } }

  const { context, collection } = found
  const title = collection.seoTitle || collection.title
  const description = collection.seoDescription || collection.description

  return {
    title,
    description: description || undefined,
    robots: catalogueRobots(context.settings),
    alternates: {
      canonical: storefrontUrl(context.settings, `/store/${token}/k/${collection.slug}`) ?? undefined,
    },
    openGraph: { title, description: description || undefined, type: 'website' },
  }
}

export default async function CollectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; slug: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { token, slug } = await params
  const { page: pageParam } = await searchParams
  const found = await resolve(token, slug)

  /*
   * Rendered as nothing rather than notFound(), matching the department route:
   * a not-found boundary would lose the shop's own chrome, and a shopper who
   * mistyped should land in the shop they were heading for.
   */
  if (!found) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10">
        <h1 className="text-xl font-semibold text-ink">We could not find that</h1>
        <p className="mt-2 text-sm text-muted">
          The link may be old, or this collection may not be on the shop any more.
        </p>
      </div>
    )
  }

  const { context, collection } = found

  const listing = await listingPresetFor(context.catalogueSiteId, 0)
  const perPage = listing.perPage
  const requested = Math.floor(Number(pageParam))
  const pageNumber = Number.isFinite(requested) && requested > 1 ? requested : 1

  /*
   * The whole collection, then the page taken from it.
   *
   * Unlike a department, a collection cannot be counted with a second query:
   * three of its six rules resolve through helpers that return products rather
   * than a countable filter, and a "count" that only worked for half of them
   * would be a pager that lied on the other half. These are capped at a couple
   * of hundred by MAX_COLLECTION_PICKS and by every rule's own limit, so
   * holding them is cheap and honest.
   */
  const [all, layout, badgeRules, bestSellers] = await Promise.all([
    collectionProducts(context, collection, { limit: 240 }),
    getPublishedLayout(context.siteId),
    shopBadgeRules(context.catalogueSiteId),
    bestSellerIds(context).catch(() => new Set<number>()),
  ])

  const total = all.length
  const lastPage = Math.max(1, Math.ceil(total / perPage))
  if (pageNumber > lastPage) {
    // One address per page, exactly as the department route argues.
    redirect(
      `/store/${token}/k/${collection.slug}${lastPage > 1 ? `?page=${lastPage}` : ''}`,
    )
  }
  const products = all.slice((pageNumber - 1) * perPage, pageNumber * perPage)

  /*
   * The collection's own built page, if a merchant made one.
   *
   * Sections render ABOVE the grid, the same way a department page's do — which
   * is what makes a lookbook: a picture-beside-words block over a row of the
   * things in it. No new section kind was needed for that.
   */
  const built = await collectionPageSections(context.catalogueSiteId, collection.id)
  const content: SectionContent[] =
    built.length > 0 ? await resolvePageContent(context, built) : []

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <h1 className="text-xl font-semibold text-ink">{collection.title}</h1>
      {collection.description && (
        <p className="mt-1 max-w-2xl text-sm text-muted">{collection.description}</p>
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

      <div className="mt-5">
        {products.length === 0 ? (
          <p className="text-sm text-muted">Nothing in this collection just now.</p>
        ) : (
          <ProductGrid
            token={token}
            products={products}
            layout={listing.layout}
            listing={listing}
            badgeRules={badgeRules}
            bestSellers={bestSellers}
            showStock={context.settings.showStock}
            showPhotos={context.settings.showPhotos}
            showBrands={context.settings.showBrands}
          />
        )}
      </div>

      <Pager
        page={pageNumber}
        perPage={perPage}
        total={total}
        basePath={`/store/${token}/k/${collection.slug}`}
        params={{}}
      />
    </div>
  )
}

/** The sections on this collection's page, or none. */
async function collectionPageSections(siteId: number, collectionId: number) {
  const { collectionPage } = await import('@/lib/site/storefrontPages')
  const page = await collectionPage(siteId, collectionId)
  if (!page || !page.isPublished) return []
  return getPublishedPageLayout(siteId, page.id)
}
