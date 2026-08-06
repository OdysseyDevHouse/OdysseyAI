import { requireCapability } from '@/lib/auth'
import { getLayout } from '@/lib/site/storefrontLayout'
import { getOnlineSettings, listDepartmentVisibility } from '@/lib/site/onlineStore'
import { createPublicStoreToken } from '@/lib/publicStoreToken'
import { PageHeader, PageBody, Badge } from '@/components/ui'
import Builder from './Builder'

/**
 * The storefront page builder.
 *
 * Everything here edits a DRAFT. The live shop does not move until Publish, so
 * an owner can rearrange over a lunch break without shoppers watching the
 * furniture slide about.
 */

export const dynamic = 'force-dynamic'

export default async function BuilderPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('online.edit')

  const [layout, settings, departments, token] = await Promise.all([
    getLayout(siteId),
    getOnlineSettings(siteId),
    listDepartmentVisibility(siteId),
    createPublicStoreToken(siteId),
  ])

  return (
    <>
      <PageHeader
        title="Page builder"
        subtitle="What customers see when they open your shop"
        action={layout.draft !== null ? <Badge tone="warning">Unpublished changes</Badge> : undefined}
      />
      <PageBody>
        <Builder
          theme={layout.theme}
          published={layout.published}
          draft={layout.draft}
          departments={departments
            .filter((d) => d.showOnline || d.publishedByParent)
            .map((d) => ({ id: d.id, name: d.name }))}
          storeOpen={settings.isEnabled}
          storePath={`/store/${token}`}
        />
      </PageBody>
    </>
  )
}
