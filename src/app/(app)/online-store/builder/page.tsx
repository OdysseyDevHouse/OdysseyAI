import { requireCapability } from '@/lib/auth'
import { getLayout } from '@/lib/site/storefrontLayout'
import { getOnlineSettings, listDepartmentVisibility } from '@/lib/site/onlineStore'
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

export default async function BuilderPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('online.edit')

  const [layout, settings, departments, token, storeName] = await Promise.all([
    getLayout(siteId),
    getOnlineSettings(siteId),
    listDepartmentVisibility(siteId),
    createPublicStoreToken(siteId),
    publicSiteName(siteId),
  ])

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
  const resolved = context ? await resolveSectionContent(context, editing) : editing.map(() => ({}))
  const bannerImages = await storefrontImagesByIds(siteId, [
    ...editing
      // A carousel's slides carry their own ids, and they need resolving here
      // for exactly the same reason a banner's does.
      .flatMap((s) => [s.imageId, ...(s.slides ?? []).map((slide) => slide.imageId)])
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
        subtitle="What customers see when they open your shop"
        action={
          layout.draft !== null ? <Badge tone="warning">Unpublished changes</Badge> : undefined
        }
      />
      <PageBody>
        <Builder
          theme={layout.theme}
          published={layout.published}
          draft={layout.draft}
          initialContent={editing.map((section, i) => ({
            section,
            ...resolved[i],
            // After the spread, so a closed shop — whose resolver returned {} —
            // still shows its banners.
            ...(section.kind === 'banner'
              ? { image: section.imageId ? bannerImages.get(section.imageId) ?? null : null }
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
