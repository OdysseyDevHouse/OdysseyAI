import { requireModuleCapability } from '@/lib/auth'
import { listJobCards, countJobCards, jobCounts } from '@/lib/site/jobCards'
import { listJobStatuses } from '@/lib/site/jobStatuses'
import { unscheduledJobCount } from '@/lib/site/jobAppointments'
import { pageFrom, offsetFor, pageCountFor, hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  StatStrip,
  StatTile,
  TableToolbar,
  LinkSegmentedControl,
  SearchBar,
  FilterBar,
  FilterChip,
  Pagination,
  Icons,
} from '@/components/ui'
import JobsTable from './JobsTable'
import JobViewStrip from './JobViewStrip'
import { listUsers } from '@/lib/site/users'
import { listJobViews } from '@/lib/site/jobViews'
import { can } from '@/lib/site/permissions'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

type Search = {
  state?: string
  status?: string
  priority?: string
  q?: string
  page?: string
  /** Which saved view is active. Carried so the strip can highlight it. */
  view?: string
}

/**
 * The job list.
 *
 * Filtering and paging live in the URL, not in React state, so a filtered list
 * is a link somebody can send and the back button does what it should.
 *
 * The four tiles are the questions a service business opens this screen with, in
 * the order it asks them: how much work is on, what has nobody picked up, what is
 * late, and how much did we finish. Only the two that mean ACT ON ME take a
 * tone — three coloured tiles would be three tiles nobody looks at.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, actor, capabilities } = await requireModuleCapability('job_cards', 'jobs.view')
  const params = await searchParams

  const state = params.state === 'closed' || params.state === 'all' ? params.state : 'open'
  const statusId = params.status ? Number(params.status) : null
  const priority = params.priority ?? ''
  const search = params.q?.trim() ?? ''
  const page = pageFrom(params.page)

  const filter = {
    state,
    statusId: Number.isFinite(statusId) && statusId ? statusId : null,
    priority,
    search,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  }

  const [jobs, total, counts, statuses, unscheduled, siteUsers, views] = await Promise.all([
    listJobCards(siteId, filter),
    countJobCards(siteId, filter),
    jobCounts(siteId),
    listJobStatuses(siteId, false),
    unscheduledJobCount(siteId),
    // Both for the bulk bar and the saved-view strip. Tolerant: a site without
    // migration 122 gets no views rather than no job list.
    listUsers(siteId).catch(() => []),
    listJobViews(siteId, actor.userId),
  ])

  const href = hrefBuilder('/jobs', params as Record<string, string | undefined>)
  const activeStatus = statuses.find((s) => s.id === filter.statusId)

  return (
    <>
      <PageHeader
        title="Job cards"
        subtitle="Work to be done, who is doing it, and what it cost."
        action={
          <PrimaryLink href="/jobs/new">
            <Icons.Plus size={15} />
            New job
          </PrimaryLink>
        }
      />
      <PageBody>
        <StatStrip columns={5}>
          <StatTile label="Open" value={String(counts.open)} href="/jobs?state=open" />
          {/* Nobody has picked these up. The tile earns a tone only when there
              is something in it, so a clean board reads as clean. */}
          <StatTile
            label="Unassigned"
            value={String(counts.unassigned)}
            tone={counts.unassigned > 0 ? 'warning' : 'default'}
          />
          {/* The PRD's Unscheduled tile: open jobs with no live FUTURE visit.
              Derived on read — a cancelled or completed visit does not make a job
              count as scheduled, and a date passing is not an event anybody
              triggers. Links to the schedule, where the empty lanes are. */}
          <StatTile
            label="Not scheduled"
            value={String(unscheduled)}
            tone={unscheduled > 0 ? 'warning' : 'default'}
            href="/jobs/schedule"
          />
          <StatTile
            label="Overdue"
            value={String(counts.overdue)}
            tone={counts.overdue > 0 ? 'danger' : 'default'}
          />
          <StatTile label="Closed" value={String(counts.closed)} href="/jobs?state=closed" />
        </StatStrip>

        <Card>
          <TableToolbar
            actions={
              /* A plain GET form, so the search survives a reload and can be
                 linked. p-0 because the toolbar already supplies the padding. */
              <SearchBar
                action="/jobs"
                defaultValue={search}
                placeholder="Job number, customer or description"
                keep={{ state, status: params.status, priority: params.priority }}
                className="p-0"
              />
            }
          >
            <LinkSegmentedControl
              options={[
                { value: 'open', label: 'Open', href: href({ state: 'open', page: undefined }) },
                { value: 'closed', label: 'Closed', href: href({ state: 'closed', page: undefined }) },
                { value: 'all', label: 'All', href: href({ state: 'all', page: undefined }) },
              ]}
              value={state}
              aria-label="Which jobs to show"
            />
          </TableToolbar>

          {(activeStatus || priority || search) && (
            <FilterBar clearHref="/jobs">
              {activeStatus && (
                <FilterChip
                  label="Status"
                  value={activeStatus.name}
                  clearHref={href({ status: undefined, page: undefined })}
                />
              )}
              {priority && (
                <FilterChip
                  label="Priority"
                  value={priority}
                  clearHref={href({ priority: undefined, page: undefined })}
                />
              )}
              {search && (
                <FilterChip
                  label="Search"
                  value={search}
                  clearHref={href({ q: undefined, page: undefined })}
                />
              )}
            </FilterBar>
          )}

          <JobViewStrip
            views={views}
            current={{
              state: params.state,
              status: params.status,
              priority: params.priority,
              q: params.q,
            }}
            activeViewId={params.view ? Number(params.view) : null}
            currentUserId={actor.userId}
          />

          <JobsTable
            jobs={jobs}
            statuses={statuses.map((s) => ({ id: s.id, name: s.name }))}
            users={siteUsers
              .filter((u) => u.isActive && u.userType === 'back_office')
              .map((u) => ({ id: u.id, name: u.name }))}
            canEdit={can(capabilities, 'jobs.edit')}
            canAssign={can(capabilities, 'jobs.assign')}
          />

          <Pagination
            page={page}
            pageCount={pageCountFor(total, PAGE_SIZE)}
            hrefFor={(next) => href({ page: String(next) })}
          />
        </Card>
      </PageBody>
    </>
  )
}
