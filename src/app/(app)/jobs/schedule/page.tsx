import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { appointmentsOn, unscheduledJobCount } from '@/lib/site/jobAppointments'
import { listJobCards } from '@/lib/site/jobCards'
import { getSetting } from '@/lib/site/settings'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  CardHeader,
  CardBody,
  StatStrip,
  StatTile,
  TableToolbar,
  Callout,
  TextLink,
  Icons,
} from '@/components/ui'
import ScheduleDay from './ScheduleDay'

export const dynamic = 'force-dynamic'

/**
 * The day, by technician.
 *
 * ── WHY A DAY AND NOT A WEEK ───────────────────────────────────────────────
 *
 * The PRD asks for day, week and technician calendars. This is the day, and the
 * week is deliberately not here yet.
 *
 * A day-by-technician grid answers the question a dispatcher opens this screen
 * with — who is free this afternoon, and who is double-booked — with lanes wide
 * enough to read a customer name in. A week view of the same data is seven
 * columns of illegible slivers unless it drops to one row per technician per day,
 * at which point it answers a different question (how loaded is next week) and
 * wants a different layout. Building the wrong one first is how a screen ends up
 * serving neither.
 *
 * ── THE TIME AXIS COMES FROM SETTINGS ──────────────────────────────────────
 *
 * job_day_starts / job_day_ends decide where a lane begins and ends. A visit
 * outside those hours still draws — clamped to the edge with a marker — because
 * hiding a booking because it is early is how somebody misses a 06:00 callout.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  const { siteId, capabilities } = await requireCapability('jobs.view')
  const { date: rawDate } = await searchParams

  // Today in the site's own wall clock, which is what the DATETIME column holds.
  const today = new Date().toISOString().slice(0, 10)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? '') ? (rawDate as string) : today

  const [visits, unscheduled, dayStarts, dayEnds] = await Promise.all([
    appointmentsOn(siteId, date),
    unscheduledJobCount(siteId),
    getSetting(siteId, 'job_day_starts'),
    getSetting(siteId, 'job_day_ends'),
  ])

  /*
   * Jobs with no live future visit, shown beside the grid so the empty lanes and
   * the work that needs a slot are on one screen. A dispatcher looking at a gap
   * wants the list of what could fill it, not another click.
   */
  const waiting = unscheduled > 0 ? await listJobCards(siteId, { state: 'open', limit: 200 }) : []
  const unscheduledIds = new Set(
    waiting
      .filter((job) => !visits.some((v) => v.jobCardId === job.id && v.isLive))
      .map((job) => job.id),
  )

  const shift = (days: number) => {
    const at = new Date(date + 'T00:00:00Z')
    at.setUTCDate(at.getUTCDate() + days)
    return `/jobs/schedule?date=${at.toISOString().slice(0, 10)}`
  }

  const live = visits.filter((v) => v.isLive)
  const unassigned = live.filter((v) => v.assignees.length === 0).length

  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle="Who is going where today."
        action={
          <PrimaryLink href="/jobs/new">
            <Icons.Plus size={15} />
            New job
          </PrimaryLink>
        }
      />
      <PageBody>
        <StatStrip columns={3}>
          <StatTile label="Booked today" value={String(live.length)} />
          <StatTile
            label="Visits with nobody assigned"
            value={String(unassigned)}
            tone={unassigned > 0 ? 'warning' : 'default'}
          />
          {/* The PRD's Unscheduled tile: open jobs with no live FUTURE visit.
              Derived, never stored — a date passing is not an event. */}
          <StatTile
            label="Jobs not scheduled"
            value={String(unscheduled)}
            tone={unscheduled > 0 ? 'warning' : 'default'}
            href="/jobs?state=open"
          />
        </StatStrip>

        <Card>
          <TableToolbar
            actions={
              <div className="flex items-center gap-2">
                <TextLink href={shift(-1)}>← Previous day</TextLink>
                <TextLink href="/jobs/schedule">Today</TextLink>
                <TextLink href={shift(1)}>Next day →</TextLink>
              </div>
            }
          >
            <span className="text-sm text-ink">
              {new Date(date + 'T00:00:00Z').toLocaleDateString('en-ZA', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                timeZone: 'UTC',
              })}
            </span>
          </TableToolbar>

          <CardBody className="p-0">
            <ScheduleDay
              date={date}
              visits={visits}
              dayStarts={dayStarts}
              dayEnds={dayEnds}
              canEdit={can(capabilities, 'jobs.edit')}
            />
          </CardBody>
        </Card>

        {unscheduledIds.size > 0 && (
          <Card>
            <CardHeader
              title="Waiting for a slot"
              description="Open jobs with no visit booked ahead of them."
            />
            <CardBody>
              <ul className="flex flex-col gap-1.5 text-sm">
                {waiting
                  .filter((job) => unscheduledIds.has(job.id))
                  .slice(0, 12)
                  .map((job) => (
                    <li key={job.id} className="flex items-center gap-2">
                      <TextLink href={`/jobs/${job.id}?tab=visits`}>
                        {job.documentNumber ?? `#${job.id}`}
                      </TextLink>
                      <span className="text-ink-2">{job.title}</span>
                      <span className="text-muted">{job.customerName ?? 'Walk-in'}</span>
                    </li>
                  ))}
              </ul>
              {unscheduledIds.size > 12 && (
                <p className="mt-2 text-xs text-muted">
                  + {unscheduledIds.size - 12} more —{' '}
                  <TextLink href="/jobs?state=open">see the job list</TextLink>
                </p>
              )}
            </CardBody>
          </Card>
        )}

        {live.length === 0 && (
          <Callout tone="neutral" title="Nothing booked for this day">
            Book a visit from a job&apos;s Visits tab and it appears here.
          </Callout>
        )}
      </PageBody>
    </>
  )
}
