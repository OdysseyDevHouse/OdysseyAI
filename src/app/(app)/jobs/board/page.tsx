import { redirect } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { defaultJobBoard } from '@/lib/site/jobBoards'
import { PageHeader, PageBody, Callout, ButtonLink } from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * /jobs/board with no slug — open whichever board comes first.
 *
 * A redirect rather than rendering the default board here, so the URL always
 * names which board is on screen. A dispatcher sending "look at this" to a
 * colleague must send them to the same board they are looking at, and
 * /jobs/board would resolve differently for somebody whose first board differs.
 */
export default async function BoardIndexPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.view')
  const board = await defaultJobBoard(siteId)

  if (board) redirect(`/jobs/board/${board.slug}`)

  return (
    <>
      <PageHeader title="Board" subtitle="Jobs arranged by the stage they are at." />
      <PageBody>
        <Callout tone="warning" title="No board is set up">
          A board decides which statuses appear as columns. Set one up and every job in
          those statuses appears on it.
        </Callout>
        <div>
          <ButtonLink href="/setup/job-workflow" variant="primary">
            Set up the workflow
          </ButtonLink>
        </div>
      </PageBody>
    </>
  )
}
