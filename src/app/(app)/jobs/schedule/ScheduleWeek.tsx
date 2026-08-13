'use client'

import { useRouter } from 'next/navigation'
import { Badge, LaneWeek, type LaneWeekBlock, type LaneWeekLane } from '@/components/ui'
import { storedDate } from '@/lib/jobStatusModel'
import type { JobAppointment } from '@/lib/site/jobAppointments'

/**
 * The week, one lane per technician.
 *
 * ── UNASSIGNED IS A LANE, NOT AN OMISSION ──────────────────────────────────
 *
 * A visit with nobody on it is the single most important row on this screen —
 * it is work booked that nobody is going to do. Dropping it because it has no
 * technician would hide exactly what a dispatcher opens the week to find, so it
 * gets a lane of its own, pinned last.
 *
 * ── A VISIT WITH TWO PEOPLE APPEARS TWICE ──────────────────────────────────
 *
 * Once in each lane, deliberately. The alternative is showing it against the
 * lead only, which would make the second person look free on a day they are
 * committed — and double-booking somebody is the mistake this screen exists to
 * prevent.
 */
export default function ScheduleWeek({
  visits,
  days,
  todayIso,
}: {
  visits: JobAppointment[]
  /** Seven ISO dates, Monday first. Computed on the server so both agree. */
  days: string[]
  todayIso: string
}) {
  const router = useRouter()

  const UNASSIGNED = '__nobody__'

  // Lanes come from who is actually booked this week rather than from the staff
  // list: a technician on leave should not hold an empty row across the screen.
  const laneNames = new Map<string, string>()
  for (const visit of visits) {
    if (visit.assignees.length === 0) laneNames.set(UNASSIGNED, 'Nobody assigned')
    for (const person of visit.assignees) {
      laneNames.set(String(person.userId), person.userName || 'Unnamed')
    }
  }

  const lanes: LaneWeekLane[] = [...laneNames.entries()]
    .filter(([id]) => id !== UNASSIGNED)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, label]) => ({
      id,
      label,
      hint: `${visits.filter((v) => v.assignees.some((p) => String(p.userId) === id)).length} visits`,
    }))

  if (laneNames.has(UNASSIGNED)) {
    lanes.push({
      id: UNASSIGNED,
      label: 'Nobody assigned',
      hint: `${visits.filter((v) => v.assignees.length === 0).length} visits`,
    })
  }

  const blocks: LaneWeekBlock[] = []
  for (const visit of visits) {
    const start = storedDate(visit.startsAt)
    if (!start) continue
    const date = visit.startsAt.slice(0, 10)
    const hh = String(start.getUTCHours()).padStart(2, '0')
    const mm = String(start.getUTCMinutes()).padStart(2, '0')
    const order = start.getUTCHours() * 60 + start.getUTCMinutes()

    const face = (
      <button
        type="button"
        onClick={() => router.push(`/jobs/${visit.jobCardId}?tab=visits`)}
        className={`w-full rounded-control border px-1.5 py-1 text-left transition hover:border-brand ${
          visit.isLive ? 'border-border bg-surface-2' : 'border-border bg-surface opacity-60'
        }`}
      >
        <span className="block text-xs font-medium text-ink">
          {hh}:{mm} {visit.jobNumber ?? `#${visit.jobCardId}`}
        </span>
        <span className="block truncate text-xs text-muted">
          {visit.customerName ?? visit.jobTitle}
        </span>
        {/* Only the states worth interrupting for. A green tick on every
            completed visit would be noise on a screen read at a glance. */}
        {!visit.isLive && (
          <Badge tone="neutral" className="mt-0.5">
            {visit.status === 'cancelled' ? 'Cancelled' : visit.status === 'no_show' ? 'No show' : 'Done'}
          </Badge>
        )}
      </button>
    )

    const laneIds =
      visit.assignees.length === 0
        ? [UNASSIGNED]
        : visit.assignees.map((p) => String(p.userId))

    for (const laneId of laneIds) {
      blocks.push({ id: `${visit.id}-${laneId}`, laneId, date, order, content: face })
    }
  }

  const dayCells = days.map((iso) => {
    const d = new Date(`${iso}T00:00:00Z`)
    const dow = d.getUTCDay()
    return {
      date: iso,
      label: `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow]} ${d.getUTCDate()}`,
      muted: dow === 0 || dow === 6,
      isToday: iso === todayIso,
    }
  })

  return (
    <LaneWeek
      lanes={lanes}
      days={dayCells}
      blocks={blocks}
      emptyLaneHint="Nothing is booked this week. Schedule a visit from a job card."
    />
  )
}
