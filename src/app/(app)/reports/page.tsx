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
  const templates = templatesFor(allow).map(toHubItem)

  // Stock intelligence is a dedicated PAGE, not an engine template — aging
  // peels movement history into layers, and turn/sell-through divide one
  // query by another, neither of which a spec can say. It still belongs in
  // this catalogue: a report nobody can find is a report that does not exist.
  if (allow('reports.financial')) {
    templates.push({
      id: 'stock-intel',
      name: 'Stock intelligence',
      description:
        'True stock aging from movement history, ABC classes, stock turn and sell-through.',
      category: 'Stock',
      source: 'products',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
    })
  }

  /*
   * Cross-store reports, for a shop with linked stores.
   *
   * Dedicated PAGES for the same reason stock intelligence is: each reads every
   * linked store's own database and merges the results, which the engine — one
   * spec against one site — cannot express. They were a "Group" section in the
   * sidebar, which cost every single-store shop a permanent two-row menu group
   * to name a word shops do not use for themselves. Here they cost nothing, and
   * are found where somebody looks for a figure spanning their stores.
   *
   * Listed whether or not this site is linked: the pages themselves show an
   * empty state pointing at Setup → Linked stores, which is the honest answer
   * and avoids a control-database read on every load of this hub.
   */
  if (allow('dashboard.view')) {
    templates.push({
      id: 'multi-store',
      name: 'Multi-store overview',
      description: 'Today, this month, gross profit and stock on hand for every linked store.',
      category: 'Multi-store',
      source: 'sales',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
    })
  }
  if (allow('reports.financial')) {
    templates.push({
      id: 'multi-store-income-statement',
      name: 'Multi-store profit and loss',
      description: 'One profit and loss across every linked store, a column each, by account code.',
      category: 'Multi-store',
      source: 'expenseLines',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
    })
  }

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Run a report, build your own, or have one generated for you."
      />
      <PageBody>
        <ReportsHub
          templates={templates}
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
