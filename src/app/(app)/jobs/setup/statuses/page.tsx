import { requireModuleCapability } from '@/lib/auth'
import { listJobStatuses, missingRoles } from '@/lib/site/jobStatuses'
import { statusesOffEveryBoard } from '@/lib/site/jobBoards'
import { PageHeader, PageBody, Callout, TextLink } from '@/components/ui'
import { ROLE_LABEL } from '@/lib/jobStatusModel'
import StatusesClient from './StatusesClient'

export const dynamic = 'force-dynamic'

/**
 * The steps a job moves through.
 *
 * ── THE TWO WARNINGS THIS SCREEN OWES THE USER ─────────────────────────────
 *
 * A required role with no holder breaks part of the lifecycle silently — a job
 * cannot be closed if nothing means completed. And a status on no board hides its
 * jobs from every board. Neither is repairable automatically without guessing,
 * so both are reported here with the counts that make them actionable.
 *
 * The second one is reported HERE rather than on the boards screen even though a
 * board is what would fix it, because the stranded jobs belong to a stage and the
 * row that names the stage is the row somebody can act on.
 */
export default async function JobStatusesPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const [statuses, missing, offBoard] = await Promise.all([
    listJobStatuses(siteId, true),
    missingRoles(siteId),
    statusesOffEveryBoard(siteId),
  ])

  const stranded = offBoard.filter((s) => s.jobCount > 0)

  return (
    <>
      <PageHeader
        title="Statuses"
        subtitle="The steps a job moves through — and what has to be true before a job can reach each one."
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
            {stranded.map((s) => `${s.jobCount} in ${s.name}`).join(', ')}. Add those statuses to a{' '}
            <TextLink href="/jobs/setup/boards">board</TextLink>, or find the jobs in the{' '}
            <TextLink href="/jobs?state=all">job list</TextLink>.
          </Callout>
        )}

        <StatusesClient statuses={statuses} offBoardIds={offBoard.map((s) => s.statusId)} />
      </PageBody>
    </>
  )
}
