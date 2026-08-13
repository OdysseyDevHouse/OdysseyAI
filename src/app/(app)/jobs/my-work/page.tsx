import { requireCapability } from '@/lib/auth'
import { myWork } from '@/lib/site/jobMyWork'
import { storedDate } from '@/lib/jobStatusModel'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  Callout,
  EmptyState,
  Badge,
  TextLink,
  PrimaryLink,
  Icons,
  type BadgeTone,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * What one technician has to do next.
 *
 * ── ACTIONS, NOT STATISTICS ────────────────────────────────────────────────
 *
 * The PRD is explicit that this screen "should prioritise actions rather than
 * management statistics", and every section here is something somebody can act
 * on: a timer still running, a visit to drive to, a check to answer, kilometres
 * nobody has approved. There is no utilisation figure and no chart — a
 * technician standing in a plant room does not need to know their own
 * throughput, and putting it here would be measuring them on the screen they
 * work from.
 *
 * ── AND NOT CONFIGURABLE ───────────────────────────────────────────────────
 *
 * /dashboard is a grid somebody arranges once and reads all week. This is opened
 * for thirty seconds between two jobs, on a phone, and a screen that has to be
 * set up before it is useful will not be. So the order is fixed, and it is the
 * order of urgency: what is running now, what is next, what is blocked, what is
 * waiting on somebody else.
 *
 * ── SCOPED TO THE READER, ALWAYS ───────────────────────────────────────────
 *
 * Everything is keyed on `actor.userId`. There is no "whose work" picker: a
 * dispatcher wanting to see somebody else's day has the schedule and the board,
 * which show everybody at once and are built for it.
 */

const PRIORITY_TONE: Record<string, BadgeTone> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'neutral',
}

/** A stored wall-clock string as a short local time. */
function at(value: string): string {
  const d = storedDate(value)
  if (!d) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** Today, tomorrow, or the date — how a person actually refers to a day. */
function dayLabel(value: string): string {
  const d = storedDate(value)
  if (!d) return ''
  const iso = value.slice(0, 10)
  const now = new Date()
  const todayIso = now.toISOString().slice(0, 10)
  const tomorrow = new Date(now)
  tomorrow.setUTCDate(now.getUTCDate() + 1)
  if (iso === todayIso) return 'Today'
  if (iso === tomorrow.toISOString().slice(0, 10)) return 'Tomorrow'
  return d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export default async function MyWorkPage() {
  const { siteId, actor } = await requireCapability('jobs.view')
  const work = await myWork(siteId, actor.userId)

  const nothing =
    work.jobs.length === 0 &&
    work.visits.length === 0 &&
    work.openTimer === null &&
    work.outstanding.length === 0 &&
    work.unverifiedTravel === 0

  return (
    <>
      <PageHeader
        title="My work"
        subtitle="What is on your plate right now."
        action={
          <PrimaryLink href="/jobs/new">
            <Icons.Plus size={15} />
            New job
          </PrimaryLink>
        }
      />
      <PageBody>
        {/* FIRST, always. A timer left running is the commonest thing a
            technician forgets, and every hour it runs unnoticed is an hour
            costed to the wrong job. */}
        {work.openTimer && (
          <Callout tone="warning" title="You still have a timer running">
            Started {at(work.openTimer.startedAt)}
            {work.openTimer.jobCardId !== null && (
              <>
                {' on '}
                <TextLink href={`/jobs/${work.openTimer.jobCardId}?tab=costs`}>
                  {work.openTimer.jobNumber ?? work.openTimer.jobTitle ?? 'a job'}
                </TextLink>
              </>
            )}
            . Stop it when you finish, or the hours land on the wrong job.
          </Callout>
        )}

        {nothing && (
          <EmptyState
            icon={<Icons.Check size={22} />}
            title="Nothing on your plate"
            hint="No jobs assigned to you, nothing booked in the next two days, and no checks outstanding."
          />
        )}

        {work.visits.length > 0 && (
          <Card>
            <CardHeader
              title="Where you are going"
              description="Today and tomorrow. Further ahead is on the schedule."
            />
            <CardBody className="p-0">
              <ul className="divide-y divide-border">
                {work.visits.map((visit) => (
                  <li key={visit.id}>
                    <TextLink
                      href={`/jobs/${visit.jobCardId}?tab=visits`}
                      className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface-2"
                    >
                      {/* The time leads, because that is what a technician scans
                          for. Wide enough for 08:00 without wrapping. */}
                      <span className="w-16 shrink-0">
                        <span className="block text-xs text-muted">{dayLabel(visit.startsAt)}</span>
                        <span className="numeric block text-sm font-medium text-ink">
                          {at(visit.startsAt)}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          {visit.customerName ?? visit.jobTitle}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {visit.addressName ?? visit.jobTitle}
                        </span>
                      </span>
                      <Icons.ArrowRight size={15} className="shrink-0 text-faint" />
                    </TextLink>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {work.outstanding.length > 0 && (
          <Card>
            <CardHeader
              title="Still to do"
              description="Required checks with no answer yet. A job cannot be closed until these are done."
            />
            <CardBody className="p-0">
              <ul className="divide-y divide-border">
                {work.outstanding.map((row) => (
                  <li key={row.jobCardId} className="px-4 py-3">
                    <TextLink href={`/jobs/${row.jobCardId}?tab=checks`}>
                      {row.jobNumber ?? row.jobTitle}
                    </TextLink>
                    {/* The item NAMES, not a count — "3 outstanding" sends
                        somebody hunting, "Gas leak test" tells them what to do. */}
                    <p className="mt-0.5 text-xs text-muted">{row.items.join(' · ')}</p>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {work.jobs.length > 0 && (
          <Card>
            <CardHeader
              title="Your open jobs"
              description="Everything you own or are assigned to, most urgent first."
            />
            <CardBody className="p-0">
              <ul className="divide-y divide-border">
                {work.jobs.map((job) => (
                  <li key={job.id}>
                    <TextLink
                      href={`/jobs/${job.id}`}
                      className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="numeric text-sm text-ink">
                            {job.documentNumber ?? `#${job.id}`}
                          </span>
                          <span className="min-w-0 truncate text-sm text-ink-2">{job.title}</span>
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {job.customerName ?? 'No customer'} · {job.statusName}
                        </span>
                      </span>
                      {job.priority !== 'normal' && job.priority !== 'low' && (
                        <Badge tone={PRIORITY_TONE[job.priority] ?? 'neutral'}>
                          {job.priority}
                        </Badge>
                      )}
                      {/* Owner and assignee are different responsibilities, and
                          somebody carrying both wants to know which is which. */}
                      {!job.asOwner && <Badge tone="neutral">helping</Badge>}
                    </TextLink>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {/* LAST, because it is the only thing here waiting on somebody else. */}
        {work.unverifiedTravel > 0 && (
          <Callout tone="neutral" title="Travel waiting to be checked">
            {work.unverifiedTravel}{' '}
            {work.unverifiedTravel === 1 ? 'trip you recorded has' : 'trips you recorded have'} not
            been approved yet. Nothing for you to do — the office signs these off.
          </Callout>
        )}
      </PageBody>
    </>
  )
}
