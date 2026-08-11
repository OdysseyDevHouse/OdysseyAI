import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { templatesFor, type ReportTemplate } from '@/lib/reportBuilder/templates'
import { listSavedReports } from '@/lib/site/savedReports'
import { listFavorites } from '@/lib/site/reportFavorites'
import { PageHeader, PageBody } from '@/components/ui'
import ReportsHub from './ReportsHub'

export const dynamic = 'force-dynamic'

/**
 * The report centre.
 *
 * Everything runnable in one place — the built-in catalogue, whatever the shop
 * has built or generated, and each person's own favourites — because the thing
 * that kills a reporting section is having to remember which of three screens a
 * report lives on.
 */
export default async function ReportsPage() {
  const { siteId, actor, capabilities } = await requireCapability('reports.view')
  const allow = (c: Parameters<typeof can>[1]) => can(capabilities, c)

  const [saved, favorites] = await Promise.all([
    listSavedReports(siteId),
    listFavorites(siteId, actor.userId),
  ])

  // Built-ins are filtered by capability here rather than in the client, so a
  // report someone may not run is never sent to their browser at all.
  const templates = templatesFor(allow)

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Run a report, build your own, or have one generated for you."
      />
      <PageBody>
        <ReportsHub
          templates={templates.map(toHubItem)}
          saved={saved.map((s) => ({
            id: `saved:${s.id}`,
            name: s.name,
            description: s.description || (s.kind === 'ask' ? s.question : ''),
            category: 'Saved' as const,
            // The dataset behind it, which gives the tile its glyph. A spec that
            // no longer validates has none, and falls back to the generic one.
            source: s.spec?.source ?? '',
            kind: s.kind,
            createdByName: s.createdByName,
            broken: s.spec === null,
          }))}
          favorites={[...favorites]}
          canBuild={allow('reports.build')}
          canSchedule={allow('reports.schedule')}
          canUseAi={allow('reports.ai')}
        />
      </PageBody>
    </>
  )
}

function toHubItem(t: ReportTemplate) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    source: t.spec.source,
    kind: 'builtin' as const,
    createdByName: '',
    broken: false,
  }
}
