'use client'

import { Button } from './Button'
import { Input } from './Field'
import * as Icons from './icons'

/**
 * A week of opening times, one row per day.
 *
 * ── WHY THIS IS A KIT COMPONENT ─────────────────────────────────────────────
 *
 * Two screens now edit a week: reservations (095) and a branch's online trading
 * hours (178). They store the SAME JSON shape and are parsed by the same
 * function, so editing them with two different controls would be a needless way
 * for the two screens to drift — one growing a validation the other lacks, one
 * calling a range a "sitting" and the other a "service".
 *
 * ── THE WEEK IS THE HARD PART ───────────────────────────────────────────────
 *
 * A day holds a LIST of ranges, not one. Lunch and dinner with a gap between is
 * the ordinary case for a restaurant, and a single from/to per day cannot say
 * it — which is the whole reason the stored shape is an array.
 *
 * An empty list means closed. That is what makes "closed Monday" expressible
 * without a separate flag per day.
 */

/** `['18:00', '21:00']`. The same tuple reservationTypes stores. */
export type HoursRange = [string, string]

/** 0 = Sunday, matching Date.getDay() and the stored JSON. */
export const WEEK_DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

/** Minutes from midnight, or null when the text is not a time. */
function parseTime(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

export function WeekHoursDay({
  label,
  ranges,
  onChange,
  rangeNoun = 'time',
  addFirstLabel = 'Open this day',
  defaultRange = ['09:00', '17:00'],
}: {
  label: string
  ranges: HoursRange[]
  onChange: (ranges: HoursRange[]) => void
  /** What one range is called here — a "sitting", a "service", a "time". */
  rangeNoun?: string
  /** The button when the day is closed. "Open this day" reads better than "Add". */
  addFirstLabel?: string
  defaultRange?: HoursRange
}) {
  function setRange(i: number, which: 0 | 1, value: string) {
    onChange(
      ranges.map((r, idx) =>
        idx === i ? ((which === 0 ? [value, r[1]] : [r[0], value]) as HoursRange) : r,
      ),
    )
  }

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-card border border-border px-4 py-2.5">
      <span className="w-24 shrink-0 pt-2 text-sm font-medium text-ink">{label}</span>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {ranges.length === 0 ? (
          <span className="pt-2 text-sm text-muted">Closed</span>
        ) : (
          ranges.map((r, i) => {
            // A backwards range is dropped on save, so say so while it is still
            // on screen rather than silently discarding what was typed.
            const from = parseTime(r[0])
            const to = parseTime(r[1])
            const bad = from !== null && to !== null && to <= from
            return (
              <div key={i} className="flex items-center gap-2">
                {/* The width lives on a wrapper, not on the Input: CONTROL sets
                    w-full, and Tailwind resolves that by stylesheet order, so a
                    w-32 passed to the control itself loses. */}
                <div className="w-32 shrink-0">
                  <Input
                    type="time"
                    value={r[0]}
                    aria-label={`${label} ${rangeNoun} ${i + 1} opens`}
                    onChange={(e) => setRange(i, 0, e.target.value)}
                  />
                </div>
                <span className="shrink-0 text-sm text-muted">to</span>
                <div className="w-32 shrink-0">
                  <Input
                    type="time"
                    value={r[1]}
                    aria-label={`${label} ${rangeNoun} ${i + 1} closes`}
                    invalid={bad}
                    onChange={(e) => setRange(i, 1, e.target.value)}
                  />
                </div>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove ${label} ${rangeNoun} ${i + 1}`}
                  onClick={() => onChange(ranges.filter((_, idx) => idx !== i))}
                >
                  <Icons.Close size={15} />
                </Button>
                {bad ? (
                  <span className="text-xs text-danger">The closing time must be later.</span>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <Button variant="ghost" size="sm" onClick={() => onChange([...ranges, defaultRange])}>
        <Icons.Plus size={15} />
        {ranges.length === 0 ? addFirstLabel : `Add a ${rangeNoun}`}
      </Button>
    </div>
  )
}

/**
 * The whole week.
 *
 * `hours` is keyed by day number as a string — the shape stored in the database
 * and read by parseOpeningHours, passed through unchanged so no caller has to
 * translate between two representations.
 */
export function WeekHours({
  hours,
  onChange,
  rangeNoun = 'time',
  addFirstLabel = 'Open this day',
  defaultRange = ['09:00', '17:00'],
}: {
  hours: Record<string, HoursRange[]>
  onChange: (hours: Record<string, HoursRange[]>) => void
  rangeNoun?: string
  addFirstLabel?: string
  defaultRange?: HoursRange
}) {
  function setDay(day: number, ranges: HoursRange[]) {
    const next = { ...hours }
    // A closed day is an ABSENT key, not an empty array: that is what the
    // parser reads back as closed, and keeping empty arrays around would store
    // seven keys for a shop that opens twice a week.
    if (ranges.length === 0) delete next[String(day)]
    else next[String(day)] = ranges
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {WEEK_DAYS.map((label, day) => (
        <WeekHoursDay
          key={label}
          label={label}
          ranges={hours[String(day)] ?? []}
          onChange={(ranges) => setDay(day, ranges)}
          rangeNoun={rangeNoun}
          addFirstLabel={addFirstLabel}
          defaultRange={defaultRange}
        />
      ))}
    </div>
  )
}
