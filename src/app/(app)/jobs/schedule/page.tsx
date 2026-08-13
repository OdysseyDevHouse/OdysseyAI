import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import {
  appointmentsOn,
  appointmentsBetween,
  unscheduledJobCount,
} from '@/lib/site/jobAppointments'
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
  LinkSegmentedControl,
  Callout,
  TextLink,
  Icons,
} from '@/components/ui'
import ScheduleDay from './ScheduleDay'
import ScheduleWeek from './ScheduleWeek'

export const dynamic = 'force-dynamic'

/**
 * The schedule, by technician — a day at a time, or a week.
 *
 * ── TWO VIEWS, BECAUSE THEY ANSWER TWO QUESTIONS ───────────────────────────
 *
 * The DAY grid has a time axis: who is free this afternoon, and who is
 * double-booked at 14:00. Lanes are wide enough to read a customer name in.
 *
 * The WEEK grid drops the time axis entirely and gives each technician one row
 * of seven cells. It answers a different question — how loaded is next week, and
 * who has nothing on Thursday — and trying to keep a time axis across seven days
 * is what turns a week view into columns of illegible slivers.
 *
 * So they are separate components over the same data rather than one grid with a
 * zoom level. The week is read-only: dragging a visit to another day or person
 * is a reassignment, needing a conflict check and an audit trail, and that is a
 * phase of its own rather than a rider on this one.
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
  searchParams: Promise<{ date?: string; view?: string }>
}) {
  const { siteId, capabilities } = await requireCapability('jobs.view')
  const { date: rawDate, view: rawView } = await searchParams

  // Narrowed rather than cast: ?view=nonsense falls back to the day.
  const view: 'day' | 'week' = rawView === 'week' ? 'week' : 'day'

  // Today in the site's own wall clock, which is what the DATETIME column holds.
  const today = new Date().toISOString().slice(0, 10)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? '') ? (rawDate as string) : today

  /*
   * The week runs Monday to Sunday, computed from the chosen date.
   *
   * getUTCDay returns 0 for Sunday, so a plain subtraction would start the week
   * on the day a British business considers its last. The `|| 7` turns Sunday
   * into the seventh day instead.
   */
  const anchor = new Date(`${date}T00:00:00Z`)
  const dow = anchor.getUTCDay() || 7
  const monday = new Date(anchor)
  monday.setUTCDate(anchor.getUTCDate() - (dow - 1))
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setUTCDate(monday.getUTCDate() + i)
    return d.toISOString().slice(0, 10)
  })

  const [visits, weekVisits, unscheduled, dayStarts, dayEnds] = await Promise.all([
    appointmentsOn(siteId, date),
    // Only fetched when the week is showing: seven days of visits is a bigger
    // read than one, and the day view has no use for it.
    view === 'week'
      ? appointmentsBetween(siteId, weekDays[0], weekDays[6])
      : Promise.resolve([]),
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
    // The view is carried, or stepping forward would drop somebody back to the
    // day grid on every click.
    const suffix = view === 'week' ? '&view=week' : ''
    return `/jobs/schedule?date=${at.toISOString().slice(0, 10)}${suffix}`
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
                {/* One step means one DAY in the day view and one WEEK in the
                    week view — stepping a week grid by a day would shuffle the
                    lanes for no reason a reader could follow. */}
                <TextLink href={shift(view === 'week' ? -7 : -1)}>
                  ← Previous {view}
                </TextLink>
                <TextLink href={`/jobs/schedule${view === 'week' ? '?view=week' : ''}`}>
                  Today
                </TextLink>
                <TextLink href={shift(view === 'week' ? 7 : 1)}>Next {view} →</TextLink>
                <LinkSegmentedControl
                  options={[
                    { value: 'day', label: 'Day', href: `/jobs/schedule?date=${date}` },
                    {
                      value: 'week',
                      label: 'Week',
                      href: `/jobs/schedule?date=${date}&view=week`,
                    },
                  ]}
                  value={view}
                  aria-label="Day or week"
                />
              </div>
            }
          >
            <span className="text-sm text-ink">
              {view === 'week'
                ? `Week of ${new Date(weekDays[0] + 'T00:00:00Z').toLocaleDateString('en-ZA', {
                    day: 'numeric',
                    month: 'long',
                    timeZone: 'UTC',
                  })}`
                : new Date(date + 'T00:00:00Z').toLocaleDateString('en-ZA', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    timeZone: 'UTC',
                  })}
            </span>
          </TableToolbar>

          <CardBody className="p-0">
            {view === 'week' ? (
              <ScheduleWeek visits={weekVisits} days={weekDays} todayIso={today} />
            ) : (
              <ScheduleDay
                date={date}
                visits={visits}
                dayStarts={dayStarts}
                dayEnds={dayEnds}
                canEdit={can(capabilities, 'jobs.edit')}
              />
            )}
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
