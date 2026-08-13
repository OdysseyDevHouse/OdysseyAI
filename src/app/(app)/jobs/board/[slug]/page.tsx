import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getJobBoard, listJobBoards, boardColumns, statusesOffEveryBoard } from '@/lib/site/jobBoards'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Callout,
  TableToolbar,
  LinkSegmentedControl,
  LinkSelect,
  Icons,
  TextLink,
} from '@/components/ui'
import { JOB_PRIORITIES, PRIORITY_LABEL } from '@/lib/jobStatusModel'
import JobBoard, { type BoardGrouping } from './JobBoard'

export const dynamic = 'force-dynamic'

type Search = { priority?: string; mine?: string; group?: string }

/**
 * One board.
 *
 * ── WHY THE BOARD IS A SEPARATE ROUTE FROM THE LIST ────────────────────────
 *
 * They answer different questions. The list answers "find me this job" — it
 * searches, sorts, pages and shows a due date. The board answers "what is the
 * state of the work" and is read from across a room. The PRD asks for both and
 * says the board must complement the grid rather than replace it, which is what
 * two routes with a shared toolbar gives.
 *
 * ── THE FILTERS THAT ARE HERE, AND THE ONES THAT ARE NOT ───────────────────
 *
 * Priority and mine-only, because both narrow a wall of cards to the ones a
 * person is answerable for. Deliberately no search: a board with one card on it
 * is a worse answer than the list, and searching is what the list is for.
 */
export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<Search>
}) {
  const { siteId, actor, capabilities } = await requireCapability('jobs.view')
  const { slug } = await params
  const query = await searchParams

  // Narrowed rather than cast: ?group=nonsense must fall back to no lanes, not
  // reach the component as a value it will silently render nothing for.
  const grouping: BoardGrouping =
    query.group === 'owner' || query.group === 'priority' ? query.group : 'none'

  const board = await getJobBoard(siteId, slug)
  if (!board) notFound()

  const priority = query.priority && JOB_PRIORITIES.includes(query.priority as never) ? query.priority : ''

  /*
   * Two ways to end up seeing only your own work: asking for it with the toggle,
   * or holding jobs.view_own without jobs.view_all. The second is not a filter
   * the user can clear, so it is applied here rather than offered.
   */
  const restricted = can(capabilities, 'jobs.view_own') && !can(capabilities, 'jobs.view')
  const mine = restricted || query.mine === '1'

  const [columns, boards, offBoard] = await Promise.all([
    boardColumns(siteId, board.id, {
      ownerUserId: mine ? actor.userId : null,
      priority,
    }),
    listJobBoards(siteId),
    can(capabilities, 'jobs.setup') ? statusesOffEveryBoard(siteId) : Promise.resolve([]),
  ])

  const href = hrefBuilder(`/jobs/board/${slug}`, query as Record<string, string | undefined>)
  const stranded = offBoard.filter((s) => s.jobCount > 0)

  return (
    <>
      <PageHeader
        title={board.name}
        subtitle="Drag a card to move the job. Every move is recorded, exactly as changing the status inside the job is."
        action={
          <PrimaryLink href="/jobs/new">
            <Icons.Plus size={15} />
            New job
          </PrimaryLink>
        }
      />
      <PageBody>
        {stranded.length > 0 && (
          /* The trap boards create: a status no board lists hides its jobs from
             every board. Reported, never repaired. */
          <Callout tone="warning" title="Some jobs are on no board">
            {stranded.map((s) => `${s.jobCount} in ${s.name}`).join(', ')}. Those statuses
            appear on no board, so this screen cannot show them.{' '}
            <TextLink href="/setup/job-workflow">Fix the columns</TextLink> or find them in
            the <TextLink href="/jobs?state=all">job list</TextLink>.
          </Callout>
        )}

        <TableToolbar
          actions={
            <div className="flex items-center gap-2">
              <LinkSelect
                aria-label="Priority"
                value={priority}
                options={[
                  { value: '', label: 'Any priority', href: href({ priority: undefined }) },
                  ...JOB_PRIORITIES.map((value) => ({
                    value,
                    label: PRIORITY_LABEL[value],
                    href: href({ priority: value }),
                  })),
                ]}
              />
              {!restricted && (
                <LinkSegmentedControl
                  options={[
                    { value: 'all', label: 'Everyone', href: href({ mine: undefined }) },
                    { value: 'mine', label: 'Mine', href: href({ mine: '1' }) },
                  ]}
                  value={mine ? 'mine' : 'all'}
                  aria-label="Whose jobs to show"
                />
              )}
              {/* Grouping SPLITS the board into lanes; it never filters. Every job
                  on the board before is on it after, which is why this sits beside
                  the filters rather than among them. */}
              <LinkSegmentedControl
                options={[
                  { value: 'none', label: 'No lanes', href: href({ group: undefined }) },
                  { value: 'owner', label: 'By person', href: href({ group: 'owner' }) },
                  { value: 'priority', label: 'By priority', href: href({ group: 'priority' }) },
                ]}
                value={grouping}
                aria-label="How to group the board"
              />
            </div>
          }
        >
          {boards.length > 1 ? (
            <LinkSegmentedControl
              options={boards.map((b) => ({
                value: b.slug,
                label: b.name,
                href: `/jobs/board/${b.slug}`,
              }))}
              value={slug}
              aria-label="Which board"
            />
          ) : (
            <TextLink href="/jobs">Job list</TextLink>
          )}
        </TableToolbar>

        <JobBoard
          boardSlug={slug}
          columns={columns}
          canMove={can(capabilities, 'jobs.edit')}
          groupBy={grouping}
        />
      </PageBody>
    </>
  )
}
