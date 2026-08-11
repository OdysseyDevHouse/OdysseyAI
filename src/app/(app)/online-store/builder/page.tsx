import { requireCapability } from '@/lib/auth'
import { getTheme } from '@/lib/site/storefrontLayout'
import {
  getPageLayout,
  homePage,
  listPages,
  listSavedSections,
  listVersions,
  type StorefrontPage,
} from '@/lib/site/storefrontPages'
import { getOnlineSettings, listDepartmentVisibility } from '@/lib/site/onlineStore'
import { liveSpecials } from '@/lib/site/specials'
import { subscriberCount } from '@/lib/site/storefrontSubscribers'
import {
  publishedDepartments,
  resolveSectionContent,
  storefrontContext,
  type StorefrontDepartment,
} from '@/lib/site/storefront'
import { storefrontImagesByIds } from '@/lib/site/storefrontImages'
import { publicSiteName } from '@/lib/sites'
import { createPublicStoreToken } from '@/lib/publicStoreToken'
import { PageHeader, PageBody, Badge } from '@/components/ui'
import Builder from './Builder'

/**
 * The storefront page builder.
 *
 * Everything here edits a DRAFT. The live shop does not move until Publish, so
 * an owner can rearrange over a lunch break without shoppers watching the
 * furniture slide about.
 *
 * The section CONTENT is resolved here, server-side, through the same function
 * the shop uses — so the preview shows the real products a shopper would see,
 * not a placeholder grid.
 */

export const dynamic = 'force-dynamic'

export default async function BuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('online.edit')
  const { page: wanted } = await searchParams

  const [theme, settings, departments, token, storeName, pages, specials, subscribers] =
    await Promise.all([
    getTheme(siteId),
    getOnlineSettings(siteId),
    listDepartmentVisibility(siteId),
    createPublicStoreToken(siteId),
    publicSiteName(siteId),
    listPages(siteId),
    // The ones a countdown could sensibly point at: switched on and not
    // finished. `liveSpecials` already answers exactly that question.
    liveSpecials(siteId),
    subscriberCount(siteId),
  ])

  /*
   * Which page is being edited.
   *
   * The id comes from the URL so the switcher is a link and the browser's back
   * button works — but it is still a claim from outside, so it is matched
   * against the site's OWN pages rather than trusted. Anything unrecognised
   * falls back to the front page rather than erroring: a stale bookmark to a
   * deleted page should land somewhere useful.
   */
  const current: StorefrontPage | null =
    pages.find((p) => String(p.id) === String(wanted)) ??
    pages.find((p) => p.kind === 'home') ??
    (await homePage(siteId))

  // No page row at all means 070 has not run here. Nothing to build.
  if (!current) {
    return (
      <>
        <PageHeader title="Page builder" subtitle="What customers see when they open your shop" />
        <PageBody>
          <p className="text-sm text-muted">This shop has no pages yet.</p>
        </PageBody>
      </>
    )
  }

  const [layoutState, versions, savedSections] = await Promise.all([
    getPageLayout(siteId, current.id),
    // Per PAGE — a version belongs to the page it replaced.
    listVersions(siteId, current.id),
    // Shop-wide, deliberately: the whole point is to use one page's section on
    // another, so scoping these per page would defeat them.
    listSavedSections(siteId),
  ])
  const layout = { theme, published: layoutState.published, draft: layoutState.draft }

  // What the owner is editing: the draft when there is one, else what is live.
  const editing = layout.draft ?? layout.published

  /*
   * The preview needs a storefront context, which only exists for an OPEN
   * shop. A closed one still has to be editable — that is the whole point of
   * building the page before opening — so the preview falls back to empty
   * content and each section explains itself instead.
   */
  const context = await storefrontContext(siteId)
  const publishedDepts: StorefrontDepartment[] = context
    ? await publishedDepartments(context)
    : []

  /*
   * Banner pictures are resolved WHATEVER the shop's state.
   *
   * `resolveSectionContent` needs a storefront context and therefore an open
   * shop, which is exactly the case a closed shop does not have — and a banner
   * is the one thing an owner most wants to see while building a page before
   * opening. So the pictures are looked up directly here and merged over
   * whatever the resolver produced.
   */
  /*
   * A department page previews ANCHORED to its own department, exactly as the
   * shop renders it — otherwise a "this department" row would draw nothing in
   * the builder and the owner would think the rule was broken.
   *
   * Nothing to pass for a product page: the builder is arranging the one layout
   * that forty thousand products share, so there is no single product to
   * anchor to, and those rows preview empty by nature.
   */
  const anchor =
    current.kind === 'department' && current.departmentId
      ? { id: 0, departmentId: current.departmentId }
      : undefined
  const resolved = context
    ? await resolveSectionContent(context, editing, anchor)
    : editing.map(() => ({}))
  const bannerImages = await storefrontImagesByIds(siteId, [
    ...editing
      // A carousel's slides and a logo strip's pictures carry their own ids,
      // and they need resolving here for exactly the same reason a banner's
      // does — a closed shop must still show them while the page is built.
      .flatMap((s) => [
        s.imageId,
        ...(s.slides ?? []).map((slide) => slide.imageId),
        ...(s.logoImageIds ?? []),
      ])
      .filter((id): id is number => typeof id === 'number' && id > 0),
    // The logo travels with them: it comes from the same library, and the
    // picker in Appearance needs it to draw a thumbnail before the dialog has
    // ever been opened.
    ...(layout.theme.logoImageId ? [layout.theme.logoImageId] : []),
  ])

  return (
    <>
      <PageHeader
        title="Page builder"
        subtitle={
          current.kind === 'home'
            ? 'What customers see when they open your shop'
            : `Editing “${current.title}”`
        }
        action={
          layout.draft !== null ? <Badge tone="warning">Unpublished changes</Badge> : undefined
        }
      />
      <PageBody>
        <Builder
          key={current.id}
          page={current}
          pages={pages}
          theme={layout.theme}
          published={layout.published}
          draft={layout.draft}
          initialContent={editing.map((section, i) => ({
            section,
            ...resolved[i],
            // After the spread, so a closed shop — whose resolver returned {} —
            // still shows its banners.
            ...(section.kind === 'banner' || section.kind === 'split'
              ? { image: section.imageId ? bannerImages.get(section.imageId) ?? null : null }
              : {}),
            // Same reasoning, and the same map: a strip's pictures must show
            // while the shop is closed and the page is still being built.
            ...(section.kind === 'logos'
              ? {
                  logoImages: new Map(
                    (section.logoImageIds ?? []).flatMap((id) => {
                      const found = bannerImages.get(id)
                      return found ? [[id, found] as const] : []
                    }),
                  ),
                }
              : {}),
            ...(section.kind === 'carousel'
              ? {
                  slideImages: new Map(
                    (section.slides ?? []).flatMap((slide) => {
                      const found = slide.imageId ? bannerImages.get(slide.imageId) : undefined
                      return found ? [[slide.imageId as number, found] as const] : []
                    }),
                  ),
                }
              : {}),
          }))}
          images={[...bannerImages.values()]}
          departments={departments
            .filter((d) => d.showOnline || d.publishedByParent)
            .map((d) => ({ id: d.id, name: d.name }))}
          publishedDepartments={publishedDepts}
          // Id and name only — see the prop's note on why whole specials do
          // not cross into the browser bundle.
          specials={specials.map((s) => ({ id: s.id, name: s.name }))}
          subscriberCount={subscribers}
          versions={versions}
          savedSections={savedSections}
          storeName={storeName ?? 'Your shop'}
          blurb={settings.blurb}
          storeOpen={settings.isEnabled}
          storePath={`/store/${token}`}
          // Exactly what the shop passes, from the same settings row — the
          // preview is only trustworthy if these agree.
          display={{
            layout: layout.theme.productLayout,
            showStock: settings.showStock,
            showPhotos: settings.showPhotos,
            showBrands: settings.showBrands,
            showDepartmentImages: settings.showDepartmentImages,
          }}
        />
      </PageBody>
    </>
  )
}
