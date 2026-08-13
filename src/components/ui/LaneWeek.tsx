'use client'

import type { ReactNode } from 'react'

/**
 * A week across, one row per person, blocks where the work is.
 *
 * The planning surface a dispatcher reads: seven columns of days, a lane per
 * technician, and every booking as a block in the cell where it falls.
 *
 * ── WHY THIS IS A KIT COMPONENT AND NOT A SCREEN ───────────────────────────
 *
 * Nothing here knows what a job is. It takes lanes, days and blocks, and draws
 * a grid — so the same component serves the visit calendar, and would serve a
 * staff roster or a delivery schedule without change. Anything that mentioned
 * appointments would have to be rewritten for the second use.
 *
 * ── WHY IT IS READ-ONLY ────────────────────────────────────────────────────
 *
 * Dragging a block to another day or another person is a REASSIGNMENT: it needs
 * a conflict check, an audit trail, and somebody told. That is a phase of its
 * own, and shipping the grid without it means a dispatcher can plan from it
 * today rather than waiting for the drag story to be right.
 *
 * ── LAYOUT ─────────────────────────────────────────────────────────────────
 *
 * CSS grid with a fixed-width lane label and seven equal columns, wrapped in a
 * horizontal scroller: on a phone the week scrolls rather than crushing each day
 * to an unreadable sliver, which is what `1fr` columns would do.
 */

export type LaneWeekDay = {
  /** ISO date, used as the key and passed back on an empty-cell click. */
  date: string
  /** Two or three letters. The component does not format dates itself. */
  label: string
  /** Weekend, holiday, or simply not a trading day — drawn dimmer. */
  muted?: boolean
  /** Today. Gets a marked column so the eye lands on it. */
  isToday?: boolean
}

export type LaneWeekBlock = {
  id: string | number
  /** Which lane and which day this belongs in. Both must match exactly. */
  laneId: string
  date: string
  /** Sort order inside the cell — usually minutes past midnight. */
  order?: number
  content: ReactNode
}

export type LaneWeekLane = {
  id: string
  label: string
  /** Shown under the name: a count, a total, whatever the screen needs. */
  hint?: string
}

export function LaneWeek({
  lanes,
  days,
  blocks,
  emptyLaneHint = 'Nothing booked',
  onEmptyClick,
}: {
  lanes: LaneWeekLane[]
  days: LaneWeekDay[]
  blocks: LaneWeekBlock[]
  emptyLaneHint?: string
  /** Called with the lane and day of an empty cell, when a screen can act on it. */
  onEmptyClick?: (laneId: string, date: string) => void
}) {
  // Bucketed once rather than filtered per cell: a 7-day, 10-lane grid is 70
  // cells, and filtering the whole block list in each is 70 passes over it.
  const byCell = new Map<string, LaneWeekBlock[]>()
  for (const block of blocks) {
    const key = `${block.laneId}|${block.date}`
    const bucket = byCell.get(key)
    if (bucket) bucket.push(block)
    else byCell.set(key, [block])
  }
  byCell.forEach((bucket) => bucket.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)))

  const columns = `10rem repeat(${days.length}, minmax(9rem, 1fr))`

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[56rem]">
        {/* Header row */}
        <div className="grid gap-px" style={{ gridTemplateColumns: columns }}>
          <div className="bg-surface-2 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">
            Who
          </div>
          {days.map((day) => (
            <div
              key={day.date}
              className={`px-3 py-2 text-xs font-medium uppercase tracking-wide ${
                day.isToday
                  ? 'bg-brand-soft text-brand'
                  : day.muted
                    ? 'bg-surface-2 text-muted'
                    : 'bg-surface-2 text-ink-2'
              }`}
            >
              {day.label}
            </div>
          ))}
        </div>

        {/* One row per lane */}
        {lanes.map((lane) => (
          <div
            key={lane.id}
            className="grid gap-px border-t border-border"
            style={{ gridTemplateColumns: columns }}
          >
            <div className="bg-surface-2 px-3 py-2">
              <p className="truncate text-sm text-ink">{lane.label}</p>
              {lane.hint && <p className="text-xs text-muted">{lane.hint}</p>}
            </div>

            {days.map((day) => {
              const cell = byCell.get(`${lane.id}|${day.date}`) ?? []
              return (
                <div
                  key={day.date}
                  className={`min-h-16 space-y-1 p-1.5 ${day.muted ? 'bg-surface-2' : 'bg-surface'}`}
                  onClick={
                    // Only when the cell is empty: a click that lands on a block
                    // belongs to the block, and swallowing it here would make
                    // every booking unclickable.
                    onEmptyClick && cell.length === 0
                      ? () => onEmptyClick(lane.id, day.date)
                      : undefined
                  }
                >
                  {cell.map((block) => (
                    <div key={block.id}>{block.content}</div>
                  ))}
                </div>
              )
            })}
          </div>
        ))}

        {lanes.length === 0 && (
          <div className="border-t border-border px-3 py-6 text-center text-sm text-muted">
            {emptyLaneHint}
          </div>
        )}
      </div>
    </div>
  )
}
