import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { catalogueFor } from '@/lib/reportBuilder/templates'
import { listFavorites } from '@/lib/site/reportFavorites'
import { PageHeader, PageBody } from '@/components/ui'
import ReportsHub from '../../reports/ReportsHub'

export const dynamic = 'force-dynamic'

/**
 * The service reports, in the section that owns them.
 *
 * ── WHY THIS SCREEN EXISTS ─────────────────────────────────────────────────
 *
 * The job reports were fifteen entries in a catalogue of ninety, filed beside
 * cash-ups and activity logs under "Operations". A workshop manager asking what
 * was written off last month had to open a reports hub that is mostly about
 * tills and stock, and then find the right corner of it. Reports about work are
 * read by the people doing the work, so they belong beside the job list, the
 * board and the schedule — the screens those same people already live in.
 *
 * ── ONE ENGINE, TWO DOORS, NO OVERLAP ──────────────────────────────────────
 *
 * This runs the SAME hub component as /reports, listing the same templates,
 * which open the same /reports/[id] viewer. Nothing is duplicated: only the
 * catalogue is cut. The cut is by CATEGORY and it is exhaustive in both
 * directions — /reports lists everything that is not 'Job cards', this lists
 * everything that is. A template therefore appears on exactly one of the two
 * screens, and adding one to templates.ts files it correctly by doing nothing.
 *
 * ── WHAT IS DELIBERATELY MISSING ───────────────────────────────────────────
 *
 * Saved and AI-generated reports are not listed here, and the build/schedule/
 * generate buttons are off. A saved report carries no category — it is filed by
 * the dataset it reads — so there is no honest way to say a shop-built one is a
 * job report rather than a sales one. Guessing from its source would put a
 * report the shop built over `jobCards` here and one over `sales` that happens
 * to be about jobs on the other screen, which is worse than a clean rule. The
 * full catalogue, including everything saved, stays one click away at /reports.
 */
export default async function JobReportsPage() {
  const { siteId, actor, capabilities } = await requireModuleCapability('job_cards', 'jobs.view')

  /*
   * Gated on reports.view as well as jobs.view.
   *
   * `requireCapability` above is the real boundary for the section; this is the
   * catalogue's own gate, and somebody who may work jobs is not automatically
   * somebody who may read what the business earned on them. Rendering an empty
   * hub rather than throwing keeps the menu entry honest — the row is visible to
   * anyone in the section, so landing on a 403 would be the confusing outcome.
   */
  const allow = (c: Parameters<typeof can>[1]) => can(capabilities, c)

  /* Through the same catalogue the main hub uses, so a job report that gains a
     switch lists each of its cuts here too rather than only there. */
  const templates = allow('reports.view')
    ? catalogueFor(allow)
        .filter((e) => e.category === 'Job cards')
        .map((e) => ({
          id: e.id,
          name: e.name,
          description: e.description,
          category: e.category,
          source: e.source,
          href: e.href,
          kind: 'builtin' as const,
          createdByName: '',
          broken: false,
        }))
    : []

  // Favourites are per user and shared with the main hub — starring "Jobs past
  // their date" here must star it there too. The shelf only shows what is in
  // scope, because it filters against the list above.
  const favorites = templates.length > 0 ? await listFavorites(siteId, actor.userId) : []

  return (
    <>
      <PageHeader
        title="Job card reports"
        subtitle="Where the work is, who did it, and what it earned."
      />
      <PageBody>
        <ReportsHub
          templates={templates}
          saved={[]}
          favorites={[...favorites]}
          canBuild={false}
          canSchedule={false}
          canUseAi={false}
          emptyHint="Your role does not include reading reports. An owner can grant this under Setup → Roles."
        />
      </PageBody>
    </>
  )
}
