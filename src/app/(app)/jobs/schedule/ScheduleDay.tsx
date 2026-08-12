'use client'

import { useRouter } from 'next/navigation'
import { Badge, EmptyState, Icons, type BadgeTone } from '@/components/ui'
import type { JobAppointment } from '@/lib/site/jobAppointments'
import {
  APPOINTMENT_STATUS_LABEL,
  APPOINTMENT_STATUS_TONE,
  overlaps,
  storedMillis,
} from '@/lib/jobStatusModel'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

/** One row of the grid: a person, or the pool of visits nobody is on yet. */
type Lane = {
  key: string
  userId: number | null
  name: string
  visits: JobAppointment[]
}

/**
 * The day drawn as one lane per technician.
 *
 * ── WHY A CSS GRID AND NOT ABSOLUTE POSITIONING ────────────────────────────
 *
 * The obvious way to draw a calendar is `position: absolute` with a computed
 * `top` and `height` per block. It works and it fights everything else: the row
 * needs a fixed height the content cannot influence, an overlapping pair has to be
 * offset by hand, and the whole thing has to be re-measured on resize.
 *
 * A grid column per time step instead. A block is `grid-column: start / span n`,
 * which the browser lays out, and two overlapping blocks simply land on two grid
 * ROWS within the lane — so the lane grows and the overlap is visible as two
 * stacked bars rather than a collision somebody has to notice.
 *
 * ── WHY THE OVERLAP IS DRAWN AT ALL ────────────────────────────────────────
 *
 * findConflicts() warns when a booking is made, and the PRD lets an authorised
 * user override it. So overlaps EXIST in the data on purpose, and a grid that
 * hid one — by drawing the second block over the first — would make the deliberate
 * ones invisible and the accidental ones undiagnosable. Stacking is the honest
 * rendering.
 */
export default function ScheduleDay({
  date,
  visits,
  dayStarts,
  dayEnds,
  canEdit,
}: {
  date: string
  visits: JobAppointment[]
  dayStarts: string
  dayEnds: string
  canEdit: boolean
}) {
  const router = useRouter()

  const from = minuteOfDay(dayStarts) ?? 7 * 60
  const to = minuteOfDay(dayEnds) ?? 17 * 60
  // 30-minute columns: fine enough that a one-hour visit is two cells wide and
  // reads as a block, coarse enough that a ten-hour day is twenty columns rather
  // than six hundred.
  const STEP = 30
  const columns = Math.max(1, Math.ceil((to - from) / STEP))

  const lanes = buildLanes(visits)

  if (lanes.length === 0) {
    return (
      <EmptyState
        title="Nothing booked"
        hint="Visits appear here once they are booked from a job. Use the arrows above to look at another day."
        icon={<Icons.CalendarClock size={22} />}
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      {/* min-w so the lanes stay readable on a narrow screen and the container
          scrolls instead of crushing them — the flex-column trap in reverse. */}
      <div className="min-w-[52rem]">
        {/* ── The hour ruler ───────────────────────────────────────────── */}
        <div
          className="grid border-b border-border"
          style={{ gridTemplateColumns: `10rem repeat(${columns}, minmax(2.25rem, 1fr))` }}
        >
          <div className="px-3 py-2 text-xs text-muted">Technician</div>
          {Array.from({ length: columns }, (_, i) => {
            const at = from + i * STEP
            // Label only on the hour: every half hour is twice the ink for the
            // same information.
            const onHour = at % 60 === 0
            return (
              <div
                key={i}
                className={`border-l border-border py-2 text-center text-xs ${
                  onHour ? 'text-ink-2' : 'text-faint'
                }`}
              >
                {onHour ? hm(at) : ''}
              </div>
            )
          })}
        </div>

        {/* ── One row per person ───────────────────────────────────────── */}
        {lanes.map((lane) => {
          const rows = stack(lane.visits)
          return (
            <div
              key={lane.key}
              className="grid border-b border-border last:border-b-0"
              style={{ gridTemplateColumns: `10rem repeat(${columns}, minmax(2.25rem, 1fr))` }}
            >
              <div className="flex flex-col justify-center px-3 py-2">
                <span className={`text-sm ${lane.userId === null ? 'text-warning' : 'text-ink'}`}>
                  {lane.name}
                </span>
                <span className="numeric text-xs text-muted">
                  {lane.visits.filter((v) => v.isLive).length} booked
                </span>
              </div>

              {/* The lane body spans every time column and holds its own grid, so
                  a stacked pair grows the row instead of overlapping. */}
              <div
                className="relative col-span-full col-start-2 grid gap-1 py-1"
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(2.25rem, 1fr))`,
                  gridTemplateRows: `repeat(${rows.length}, minmax(2.5rem, auto))`,
                }}
              >
                {rows.map((row, rowIndex) =>
                  row.map((visit) => {
                    const placed = place(visit, from, to, STEP, columns)
                    return (
                      <button
                        key={visit.id}
                        type="button"
                        onClick={() => router.push(`/jobs/${visit.jobCardId}?tab=visits`)}
                        style={{
                          gridColumn: `${placed.start} / span ${placed.span}`,
                          gridRow: rowIndex + 1,
                        }}
                        className={`flex flex-col justify-center overflow-hidden rounded-control border px-2 py-1 text-left ${
                          visit.isLive
                            ? 'border-border bg-surface hover:bg-surface-2'
                            : 'border-border bg-surface-2 opacity-70'
                        }`}
                        title={`${visit.jobNumber ?? ''} ${visit.jobTitle} — ${APPOINTMENT_STATUS_LABEL[visit.status]}`}
                      >
                        <span className="truncate text-xs text-ink">
                          {visit.customerName ?? visit.jobTitle}
                        </span>
                        <span className="flex items-center gap-1 truncate text-xs text-muted">
                          {/* Clamped blocks say so, so a bar touching the edge is
                              not read as ending there. */}
                          {placed.clippedStart && <span title="Starts before the working day">←</span>}
                          {visit.jobNumber ?? `#${visit.jobCardId}`}
                          {placed.clippedEnd && <span title="Runs past the working day">→</span>}
                        </span>
                        {/* The status chip only when it is not the ordinary case —
                            a lane of seven "Booked" badges says nothing. */}
                        {visit.status !== 'scheduled' && (
                          <Badge tone={TONE[APPOINTMENT_STATUS_TONE[visit.status]] ?? 'neutral'}>
                            {APPOINTMENT_STATUS_LABEL[visit.status]}
                          </Badge>
                        )}
                      </button>
                    )
                  }),
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * One lane per person, plus a lane for visits nobody is on.
 *
 * A visit with two people appears in BOTH lanes, deliberately: the question a lane
 * answers is "what is this person doing", and leaving somebody out because they
 * were the second name on the job would make their afternoon look free.
 */
function buildLanes(visits: readonly JobAppointment[]): Lane[] {
  const byUser = new Map<number, Lane>()
  const orphans: JobAppointment[] = []

  for (const visit of visits) {
    if (visit.assignees.length === 0) {
      orphans.push(visit)
      continue
    }
    for (const person of visit.assignees) {
      if (!byUser.has(person.userId)) {
        byUser.set(person.userId, {
          key: `u${person.userId}`,
          userId: person.userId,
          name: person.userName || `User ${person.userId}`,
          visits: [],
        })
      }
      byUser.get(person.userId)!.visits.push(visit)
    }
  }

  const lanes = [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name))

  // Unassigned first: it is the row that needs somebody to act.
  if (orphans.length > 0) {
    lanes.unshift({ key: 'none', userId: null, name: 'Nobody assigned', visits: orphans })
  }
  return lanes
}

/**
 * Split a lane's visits into rows so no row contains an overlap.
 *
 * Greedy first-fit: walk the visits in time order and drop each into the first row
 * where it does not collide. Two back-to-back visits share a row; a genuine
 * double-booking makes a second row and both are visible.
 */
function stack(visits: readonly JobAppointment[]): JobAppointment[][] {
  const sorted = [...visits].sort((a, b) => minutesOf(a.startsAt) - minutesOf(b.startsAt))
  const rows: JobAppointment[][] = []

  for (const visit of sorted) {
    const start = minutesOf(visit.startsAt)
    const row = rows.find(
      (candidate) =>
        !candidate.some((other) =>
          overlaps(start, visit.durationMinutes, minutesOf(other.startsAt), other.durationMinutes),
        ),
    )
    if (row) row.push(visit)
    else rows.push([visit])
  }

  return rows.length === 0 ? [[]] : rows
}

/**
 * Where a block sits, clamped to the drawn day.
 *
 * A visit starting at 06:00 on a day drawn from 07:00 is clamped to column 1 and
 * marked — hiding it because it is early is how somebody misses a dawn callout.
 */
function place(
  visit: JobAppointment,
  from: number,
  to: number,
  step: number,
  columns: number,
): { start: number; span: number; clippedStart: boolean; clippedEnd: boolean } {
  const at = new Date(storedMillis(visit.startsAt))
  const startMinute = at.getUTCHours() * 60 + at.getUTCMinutes()
  const endMinute = startMinute + visit.durationMinutes

  const clampedStart = Math.max(startMinute, from)
  const clampedEnd = Math.min(endMinute, to)

  const start = Math.floor((clampedStart - from) / step) + 1
  const span = Math.max(1, Math.ceil((clampedEnd - clampedStart) / step))

  return {
    start: Math.min(Math.max(start, 1), columns),
    span: Math.min(span, columns - Math.min(Math.max(start, 1), columns) + 1),
    clippedStart: startMinute < from,
    clippedEnd: endMinute > to,
  }
}

/* The pool stores DATETIME as a UTC wall clock — read it back with getUTC*, and
   through storedMillis so an already-zoned value is not double-suffixed. */
function minutesOf(value: string): number {
  return Math.round(storedMillis(value) / 60_000)
}

function minuteOfDay(value: string): number | null {
  const [h, m] = String(value).split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
}

function hm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
