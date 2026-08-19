import Link from 'next/link'
import type { Metadata } from 'next'
import { verifyPublicStoreToken } from '@/lib/publicStoreToken'
import { resolvePageContent, storefrontContext } from '@/lib/site/storefront'
import { getTheme } from '@/lib/site/storefrontLayout'
import {
  getPageSectionsFor,
  listPages,
  publishedPageBySlug,
} from '@/lib/site/storefrontPages'
import { verifyPreviewToken } from '@/lib/previewToken'
import { safeSlug } from '@/lib/storefrontModel'
import HomeSections, { type SectionContent } from '../../HomeSections'
import PreviewBar from '../../PreviewBar'
import { catalogueRobots } from '@/lib/site/storefrontSeo'

/**
 * One of the shop's own pages — About, Delivery, Returns, a FAQ.
 *
 * ── WHY THIS ROUTE EXISTS ────────────────────────────────────────────────
 *
 * Until now the builder could only build the FRONT page, which meant a shop
 * taking payments had nowhere at all to publish a refund policy. Everything
 * here is the ordinary section machinery pointed at a different row: same
 * kinds, same resolver, same renderer.
 *
 * ── UNPUBLISHED IS INDISTINGUISHABLE FROM ABSENT ─────────────────────────
 *
 * `publishedPageBySlug` returns null for a page that exists but is not live,
 * and this renders the same "we couldn't find that" either way. Distinguishing
 * them would let anyone enumerate the pages a shop is drafting — the same
 * argument the department route makes about a department nobody publishes.
 */

export const dynamic = 'force-dynamic'

/**
 * The page, resolving a preview pass if one was given.
 *
 * ── AN UNPUBLISHED PAGE IS REACHABLE ONLY WITH A PASS ────────────────────
 *
 * `publishedPageBySlug` deliberately cannot see a page that is switched off,
 * which is what makes an unpublished page indistinguishable from one that
 * never existed. Previewing has to reach exactly those pages, so it looks the
 * page up by slug WITHOUT the published filter — and then only accepts it if
 * the pass names that same page and the same site.
 *
 * The order matters: the pass is verified first and the lookup is narrowed to
 * what it names, so no code path can widen the search on an invalid pass.
 */
async function resolve(token: string, slug: string, previewToken: string | undefined) {
  const siteId = await verifyPublicStoreToken(token)
  if (siteId === null) return null
  const context = await storefrontContext(siteId)
  if (!context) return null

  const preview = previewToken ? await verifyPreviewToken(previewToken) : null

  // A valid pass for THIS site may see an unpublished page — but only the one
  // it names, matched by id after the slug lookup.
  if (preview && preview.siteId === siteId) {
    const page = (await listPages(siteId)).find(
      (p) => p.id === preview.pageId && p.slug === safeSlug(slug) && p.kind === 'standard',
    )
    if (page) return { context, page, preview }
  }

  const page = await publishedPageBySlug(siteId, slug)
  if (!page) return null

  return { context, page, preview: null }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string; slug: string }>
}): Promise<Metadata> {
  const { token, slug } = await params
  /*
   * No preview pass here, deliberately.
   *
   * Metadata is what a link looks like when SHARED, and a draft is not a thing
   * to share — so an unpublished page keeps the plain "not found" card even
   * while its owner is looking at the page itself. Passing the pass through
   * would also mean a preview URL forwarded to somebody produced a rich
   * preview card of unpublished work in their chat client.
   */
  const found = await resolve(token, slug, undefined)
  if (!found) return { title: 'Not found', robots: { index: false, follow: false } }

  const { context, page } = found
  /*
   * The page's own words when it has them, the shop's when it does not.
   *
   * A page carrying nothing is the common case at first, and falling back to
   * the storefront's title is what the layout already does — better a correct
   * shop name than an empty card.
   */
  const title = page.seoTitle.trim() || `${page.title} · ${context.storeName}`
  const description =
    page.seoDescription.trim() || context.settings.blurb || `${page.title} — ${context.storeName}`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'article',
      // The public image route, which re-checks the store is open before
      // serving a byte — the same one the sections themselves use.
      ...(page.seoImageId
        ? { images: [{ url: `/api/store-images/${token}/shop/${page.seoImageId}` }] }
        : {}),
    },
    /*
     * The shop's own choice, decided in one place — see storefrontSeo.
     *
     * This was hard-coded to `index: false` while every other route asked
     * `catalogueRobots`. The effect was quiet and backwards: a shop that turned
     * indexing ON got its products indexed and its About, Delivery and Returns
     * pages silently excluded — the three pages a shopper searches for by name,
     * and the ones a shop is judged on for having.
     */
    robots: catalogueRobots(context.settings),
  }
}

export default async function StandardPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string; slug: string }>
  searchParams: Promise<{ preview?: string }>
}) {
  const { token, slug } = await params
  const { preview: previewToken } = await searchParams
  const found = await resolve(token, slug, previewToken)

  /*
   * Rendered inline rather than notFound(), matching the department route: a
   * not-found boundary loses the shop's own chrome, and a shopper who follows
   * a stale link should land in the shop they were heading for.
   */
  if (!found) {
    return (
      <div className="py-10 text-center">
        <h1 className="text-lg font-semibold text-ink">We couldn&rsquo;t find that page</h1>
        <p className="mt-2 text-sm text-muted">It may have been taken down.</p>
        <Link
          href={`/store/${token}`}
          className="mt-5 inline-block text-sm font-medium text-brand hover:underline"
        >
          Back to the shop
        </Link>
      </div>
    )
  }

  const { context, page, preview } = found
  const [theme, { sections, isPreview }] = await Promise.all([
    getTheme(context.siteId),
    // One rule for draft-vs-published, shared with the other routes — see
    // getPageSectionsFor on the three ways this can be got wrong.
    getPageSectionsFor(context.siteId, page.id, preview),
  ])

  const content: SectionContent[] = await resolvePageContent(context, sections)

  return (
    <div>
      {isPreview && <PreviewBar builderHref={`/online-store/builder?page=${page.id}`} />}
      {/*
        The page's own title, always — unlike the front page, where the heading
        is a hero section the owner may not have added. A policy page with no
        visible name is one a shopper cannot tell they reached.
      */}
      <h1 className="text-xl font-semibold text-ink">{page.title}</h1>

      {content.length > 0 ? (
        <div className="mt-4">
          <HomeSections
            token={token}
            content={content}
            theme={theme}
            display={{
              layout: theme.productLayout,
              showStock: context.settings.showStock,
              showPhotos: context.settings.showPhotos,
              showBrands: context.settings.showBrands,
              showDepartmentImages: context.settings.showDepartmentImages,
            }}
            imageSrc={(imageId) => `/api/store-images/${token}/shop/${imageId}`}
          />
        </div>
      ) : (
        /*
          A published page with nothing on it. Reachable: publishing and
          building are separate steps, deliberately, so an owner can tick
          "published" before writing a word. Saying so plainly beats a blank
          area that reads as a rendering fault.
        */
        <p className="mt-4 text-sm text-muted">There is nothing on this page yet.</p>
      )}
    </div>
  )
}
