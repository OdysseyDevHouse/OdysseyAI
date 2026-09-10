import { requireModuleCapability } from '@/lib/auth'
import { listJobStatuses } from '@/lib/site/jobStatuses'
import { listJobBoards, statusesOffEveryBoard, boardStatusIds } from '@/lib/site/jobBoards'
import { PageHeader, PageBody, Callout, TextLink } from '@/components/ui'
import BoardsClient from './BoardsClient'

export const dynamic = 'force-dynamic'

/**
 * The views a team works from.
 *
 * Reads the stages too, because the editor ticks them — but only to tick. The
 * stage list is owned by /jobs/setup/statuses, and this page cannot change one.
 */
export default async function JobBoardsPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const [statuses, boards, offBoard] = await Promise.all([
    listJobStatuses(siteId, true),
    listJobBoards(siteId, true),
    statusesOffEveryBoard(siteId),
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
        title="Workflow boards"
        subtitle="The views your team works from, and what each one shows."
      />
      <PageBody>
        {stranded.length > 0 && (
          /* The same warning the statuses screen carries, because this is the
             screen that can FIX it: a stage reaches a board from here. */
          <Callout tone="warning" title="Some jobs are on no board">
            {stranded.map((s) => `${s.jobCount} in ${s.name}`).join(', ')}. Tick those stages on a
            board below, or find the jobs in the{' '}
            <TextLink href="/jobs?state=all">job list</TextLink>.
          </Callout>
        )}

        <BoardsClient boards={boards} statuses={statuses} columnsByBoard={columnsByBoard} />
      </PageBody>
    </>
  )
}
