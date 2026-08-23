import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { has } from '@/lib/control/modules'
import { templatesFor, type ReportTemplate } from '@/lib/reportBuilder/templates'
import { listSavedReports } from '@/lib/site/savedReports'
import { listFavorites } from '@/lib/site/reportFavorites'
import { PageHeader, PageBody } from '@/components/ui'
import ReportsHub, { type HubItem } from './ReportsHub'

export const dynamic = 'force-dynamic'

/**
 * The reports most shops actually open, listed together under a Popular tab.
 *
 * A DUPLICATE listing, not a move: every one of these is still filed under its
 * own subject, and the tab holds the same tile with the same star and the same
 * route. A catalogue of ninety reports has a long tail nobody runs and a head
 * of five that get run every morning, and making somebody remember which
 * subject the morning five are filed under is the tax this removes.
 *
 * By ID rather than by a flag on the template, deliberately. "Popular" is an
 * editorial claim about this hub — the order below is the running order — and
 * not a property of the report itself; the Job cards screen runs the same
 * templates and singles none of them out. Keeping it here also means an id that
 * names a report the person's role cannot run simply finds nothing and drops
 * out, rather than needing a permission check of its own.
 */
const POPULAR_REPORTS = [
  'invoice-history',
  'cashup-history',
  'performance',
  /* "Sales by day or month" was listed here too, until it was folded into
     `turnover-by` as its two margin cuts — the same question at the same
     grains, and two tiles nobody could choose between by name. */
  'turnover-by',
]

/**
 * The report centre.
 *
 * Everything runnable in one place — the built-in catalogue, whatever the shop
 * has built or generated, and each person's own favourites — because the thing
 * that kills a reporting section is having to remember which of three screens a
 * report lives on.
 */
export default async function ReportsPage() {
  const { siteId, actor, capabilities, modules } = await requireCapability('reports.view')
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
   * Listed whether or not this site is LINKED: the pages themselves show an
   * empty state pointing at Setup → Linked stores, which is the honest answer
   * for a shop that has bought Multi-Branch but not set it up yet.
   *
   * But hidden entirely when the module has not been bought. That check used to
   * be avoided here because it meant a control-database read on every load of
   * this hub; it no longer does — `requireCapability` above has already
   * resolved the shop's modules for this request, so asking is free.
   */
  if (allow('dashboard.view') && has(modules, 'multi_branch')) {
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
  if (allow('reports.view')) {
    templates.push({
      id: 'multi-store-sales',
      name: 'Sales by store',
      description: 'Turnover per store, day by day or month by month — who is growing and who is sliding.',
      category: 'Multi-store',
      source: 'sales',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
    })
    templates.push({
      id: 'multi-store-mix',
      name: 'Sales mix by store',
      description:
        'What sells, how it is paid for, and when the shops are busy — three cuts, every store.',
      category: 'Multi-store',
      source: 'saleLines',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
    })
    templates.push({
      id: 'multi-store-like-for-like',
      name: 'Like-for-like sales',
      description:
        'Growth against the same period last year, counting only the stores that traded in both.',
      category: 'Multi-store',
      source: 'sales',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
    })
  }
  /* Gated on products.view, not reports.*: it reads the product file rather
     than the ledger, and it is only meaningful for stores that SHARE that file
     — the page says so when they do not. */
  if (allow('products.view')) {
    templates.push({
      id: 'multi-store-stock',
      name: 'Stock across stores',
      description:
        'What each store holds, and where stock should move when one is short and another has surplus.',
      category: 'Multi-store',
      source: 'products',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
    })
  }
  /* Stock, not reports: it is the movement of goods between shops, and the
     person who chases a transfer is the one who runs the stockroom. */
  if (allow('stock.view')) {
    templates.push({
      id: 'multi-store-transfers',
      name: 'Store transfers',
      description: 'What moved between stores, what is on the road, and what is counted twice.',
      category: 'Multi-store',
      source: 'stockMovements',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
    })
  }
  if (allow('reports.financial')) {
    templates.push({
      id: 'multi-store-balance-sheet',
      name: 'Multi-store balance sheet',
      description:
        'What the whole group owns and owes at a date, a column per store, by account code.',
      category: 'Multi-store',
      source: 'journalLines',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
    })
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

  /*
   * The audit trail, which is a PAGE rather than a spec.
   *
   * It belongs in this catalogue: "who changed this price" and "who signed in
   * on Tuesday" are questions somebody arrives at the reports screen holding,
   * and it was filed under Setup — beside the settings that DECIDE things —
   * where nobody looking for an answer would think to open it.
   *
   * The ROUTE stays at /setup/audit — the screen reads two logs across records
   * with its own filters and tabs, which the engine's one-spec-one-source shape
   * cannot express, so there is nothing to port. Only the listing moved: the
   * setup catalogue no longer names it, and SUBPAGE_OWNER points its breadcrumb
   * here so the trail reads "Reports › Audit trail" and leads back to this
   * screen. It cannot be starred — a favourite is keyed on a report id and
   * there is no spec behind this one.
   */
  if (allow('setup.audit')) {
    templates.push({
      id: 'audit-trail',
      name: 'Audit trail',
      description: 'Every change anyone made, and who signed in when.',
      category: 'Operations',
      source: 'activity',
      kind: 'builtin' as const,
      createdByName: '',
      broken: false,
      href: '/setup/audit',
      unstarrable: true,
    })
  }

  /*
   * Job card reports are NOT listed here.
   *
   * They have their own screen, under the Job cards section that owns them —
   * see /jobs/reports. A report reachable from two front doors is the problem
   * that hub screens exist to solve, and the service reports are the set most
   * likely to be read by somebody who never opens this catalogue at all.
   *
   * Filtered by CATEGORY rather than by id prefix: the category is the thing
   * the Job cards screen selects on, so a new template lands on exactly one of
   * the two screens and can never be listed twice or go missing from both.
   */
  const general = templates.filter((t) => t.category !== 'Job cards')

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Run a report, build your own, or have one generated for you."
      />
      <PageBody>
        <ReportsHub
          templates={general}
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
          popular={POPULAR_REPORTS}
          canBuild={allow('reports.build')}
          canSchedule={allow('reports.schedule')}
          canUseAi={allow('reports.ai')}
        />
      </PageBody>
    </>
  )
}

/* Annotated rather than inferred, so the pushes below may carry the optional
   fields a PAGE tile needs — an inferred literal type has neither. */
function toHubItem(t: ReportTemplate): HubItem {
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
