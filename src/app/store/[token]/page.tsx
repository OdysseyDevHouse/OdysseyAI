import { notFound, redirect } from 'next/navigation'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { resolveStorefront } from '@/lib/storeRouting'
import {
  publishedProducts,
  resolveSectionContent,
  storefrontContext,
} from '@/lib/site/storefront'
import { getPublishedLayout } from '@/lib/site/storefrontLayout'
import { getPageSectionsFor, homePage } from '@/lib/site/storefrontPages'
import { verifyPreviewToken } from '@/lib/previewToken'
import { sectionIsEmpty } from '@/lib/storefrontModel'
import PreviewBar from './PreviewBar'
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
  searchParams: Promise<{ department?: string; q?: string; preview?: string }>
}) {
  const { token } = await params
  const query = await searchParams

  const shop = await resolveStorefront(token)
  if (!shop) notFound()
  const { context } = shop
  // The BRANCH. Every stock figure on this page is one shop's promise.
  const siteId = context.siteId

  const { settings } = context
  const departmentId = Number(query.department)
  const searching = Boolean(query.q?.trim())

  /*
   * ── ONE DEPARTMENT ROUTE, NOT TWO ────────────────────────────────────────
   *
   * A department used to be reachable two ways: `?department=` here, and the
   * dedicated /c/<id> page. Both worked, they rendered DIFFERENT components,
   * and the front page's own category tiles linked to the query one while the
   * department rail linked to the other — so which experience a shopper got
   * depended on where they clicked.
   *
   * /c/<id> wins because it is the only one that can carry its own <title>,
   * description and share image: a query parameter has no page of its own to
   * hang metadata on, which makes it a dead end the moment a department wants
   * a decent WhatsApp preview.
   *
   * The old form REDIRECTS rather than 404s. These links are on posters, in
   * WhatsApp messages and in customers' bookmarks, and breaking them to tidy
   * up routing would be a self-inflicted wound. A search inside a department
   * keeps its term across the hop.
   */
  if (Number.isInteger(departmentId) && departmentId > 0) {
    const term = query.q?.trim()
    redirect(`/store/${token}/c/${departmentId}${term ? `?q=${encodeURIComponent(term)}` : ''}`)
  }

  const layout = await getPublishedLayout(siteId)

  // Searching with no department — the catalogue, with its filters.
  if (searching) {
    const products = await publishedProducts(context, {
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
  //
  // A preview pass swaps the published sections for the draft — see
  // getPageSectionsFor. Resolved AFTER that, so a draft's contents come from
  // the same resolver a shopper's request uses.
  const home = await homePage(siteId)
  const preview = query.preview ? await verifyPreviewToken(query.preview) : null
  const shown = home
    ? await getPageSectionsFor(siteId, home.id, preview)
    : { sections: layout.sections, isPreview: false }

  const resolved = await resolveSectionContent(context, shown.sections)
  const content: SectionContent[] = shown.sections.map((section, i) => ({
    section,
    ...resolved[i],
  }))
  /*
   * Would this page draw anything at all?
   *
   * ── ASKED THROUGH `sectionIsEmpty`, NOT RE-STATED HERE ────────────────
   *
   * This used to hand-enumerate six kinds, which is precisely the mirror
   * `sectionIsEmpty` was extracted to prevent: it was already silently wrong
   * for a carousel, and adding a kind meant remembering to come back here.
   * Nobody would — the failure is invisible, and it is a bad one. A page of
   * only new sections would be judged "empty" and replaced by the catalogue,
   * throwing away the page the owner built.
   *
   * A spacer and a divider are excluded deliberately. Both are never "empty" —
   * drawing themselves IS their content — but a page holding nothing else is
   * a page with nothing on it, and should still fall back to the catalogue.
   */
  const anythingToShow = content.some(
    (fill) =>
      fill.section.kind !== 'spacer' &&
      fill.section.kind !== 'divider' &&
      !sectionIsEmpty(fill, layout.theme),
  )

  // A front page that would render nothing is worse than no front page: fall
  // back to the catalogue so a shopper always lands on something to buy.
  if (!anythingToShow) {
    const products = await publishedProducts(context, { limit: 120 })
    return (
      <>
        {/* Kept even here. An owner previewing a draft they have emptied is
            looking at the catalogue and would otherwise conclude the preview
            is broken — the bar is what tells them the fallback is deliberate. */}
        {shown.isPreview && <PreviewBar builderHref="/online-store/builder" />}
        <Catalogue
          token={token}
          products={products}
          layout={layout.theme.productLayout}
          showStock={settings.showStock}
          showPhotos={settings.showPhotos}
          showBrands={settings.showBrands}
          query=""
        />
      </>
    )
  }

  return (
    <>
    {shown.isPreview && <PreviewBar builderHref="/online-store/builder" />}
    <HomeSections
      token={token}
      content={content}
      theme={layout.theme}
      display={{
        layout: layout.theme.productLayout,
        showStock: settings.showStock,
        showPhotos: settings.showPhotos,
        showBrands: settings.showBrands,
        showDepartmentImages: settings.showDepartmentImages,
      }}
      // The PUBLIC route: it re-checks the store is open before serving a
      // byte. The builder passes the back-office one, which does not — see
      // ImageSrc on why that difference lives in the callers.
      imageSrc={(imageId) => `/api/store-images/${token}/shop/${imageId}`}
    />
    </>
  )
}
