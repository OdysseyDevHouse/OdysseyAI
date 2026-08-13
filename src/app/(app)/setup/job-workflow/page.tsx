import { requireCapability } from '@/lib/auth'
import { listJobStatuses, missingRoles } from '@/lib/site/jobStatuses'
import { listJobBoards, statusesOffEveryBoard, boardStatusIds } from '@/lib/site/jobBoards'
import { listSlaPolicies, untargetedJobCount } from '@/lib/site/jobSla'
import { listHeadlines } from '@/lib/site/jobHeadlines'
import { listAssetTypes } from '@/lib/site/jobAssets'
import { getSettings } from '@/lib/site/settings'
import { PageHeader, PageBody, Callout, TextLink } from '@/components/ui'
import { ROLE_LABEL } from '@/lib/jobStatusModel'
import WorkflowClient from './WorkflowClient'
import SlaPanel from './SlaPanel'
import HeadlinesPanel from './HeadlinesPanel'
import AssetTypesPanel from './AssetTypesPanel'

export const dynamic = 'force-dynamic'

/**
 * How this business runs a job.
 *
 * ── WHY THIS LIVES UNDER /setup AND NOT UNDER /jobs ────────────────────────
 *
 * The Jobs section is what somebody works in all day; this is set once and
 * revisited rarely. nav.ts has the argument in full: naming every setting in the
 * sidebar is what made Online Store a flat list of fourteen rows that answered
 * nothing. So the route stays in the setup hub, is named in SUBPAGE_LABELS, and
 * the breadcrumb reads Setup > Job workflow.
 *
 * ── THE TWO WARNINGS THIS SCREEN OWES THE USER ─────────────────────────────
 *
 * A required role with no holder breaks part of the lifecycle silently — a job
 * cannot be closed if nothing means completed. And a status on no board hides its
 * jobs from every board. Neither is repairable automatically without guessing,
 * so both are reported here with the counts that make them actionable.
 */
export default async function JobWorkflowPage() {
  const { siteId } = await requireCapability('jobs.setup')

  const [
    statuses,
    boards,
    missing,
    offBoard,
    policies,
    settings,
    untargeted,
    headlines,
    assetTypes,
  ] = await Promise.all([
    listJobStatuses(siteId, true),
    listJobBoards(siteId, true),
    missingRoles(siteId),
    statusesOffEveryBoard(siteId),
    listSlaPolicies(siteId, true),
    getSettings(siteId, [
      'job_sla_trading_days',
      'job_sla_opens_at',
      'job_sla_closes_at',
      'job_sla_skip_holidays',
    ]),
    /*
     * Tolerant: a nicety on a setup screen. A site mid-migration must still be
     * able to configure its statuses.
     */
    untargetedJobCount(siteId).catch(() => 0),
    // Tolerant: a site without migration 114 still gets its statuses and boards.
    listHeadlines(siteId, true).catch(() => []),
    // Likewise 115.
    listAssetTypes(siteId, true).catch(() => []),
  ])

  // Which statuses each board draws, so the editor opens with them ticked.
  const columnsByBoard: Record<number, number[]> = {}
  await Promise.all(
    boards.map(async (board) => {
      columnsByBoard[board.id] = await boardStatusIds(siteId, board.id)
    }),
  )

  const stranded = offBoard.filter((s) => s.jobCount > 0)

  return (
    <>
      <PageHeader
        title="Job workflow"
        subtitle="The stages a job moves through, and the boards that show them."
      />
      <PageBody>
        {missing.length > 0 && (
          <Callout tone="danger" title="Part of the lifecycle has nowhere to go">
            Nothing means: {missing.map((role) => ROLE_LABEL[role].toLowerCase()).join(', ')}. Until
            a status carries each of those, the actions that look for them will refuse.
          </Callout>
        )}

        {stranded.length > 0 && (
          <Callout tone="warning" title="Some jobs are on no board">
            {stranded.map((s) => `${s.jobCount} in ${s.name}`).join(', ')}. Add those statuses to a
            board below, or find the jobs in the{' '}
            <TextLink href="/jobs?state=all">job list</TextLink>.
          </Callout>
        )}

        <WorkflowClient
          statuses={statuses}
          boards={boards}
          columnsByBoard={columnsByBoard}
          offBoardIds={offBoard.map((s) => s.statusId)}
        />

        {/* What KIND of work this business does, above the promises: a headline
            decides a job's priority and board, so it reads before the things that
            measure it. */}
        <HeadlinesPanel
          headlines={headlines}
          boards={boards.filter((b) => b.isActive).map((b) => ({ id: b.id, name: b.name }))}
        />

        {/* Kinds of EQUIPMENT, after kinds of WORK: both are what a business does,
            and a service interval is the thing that turns equipment into work. */}
        <AssetTypesPanel types={assetTypes} />

        {/* The promises, on the same screen as the stages rather than a route of
            their own: both answer "how does this business run a job", and four
            settings plus four rows do not earn a sidebar entry. */}
        <SlaPanel
          policies={policies}
          tradingDays={settings.job_sla_trading_days}
          opensAt={settings.job_sla_opens_at}
          closesAt={settings.job_sla_closes_at}
          skipHolidays={settings.job_sla_skip_holidays === '1'}
          untargetedCount={untargeted}
        />
      </PageBody>
    </>
  )
}
