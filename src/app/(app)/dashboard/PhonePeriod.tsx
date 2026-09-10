'use client'

import { useState } from 'react'
import { Button, DateRangeField, Modal, SegmentedControl, type DateRange } from '@/components/ui'

/**
 * The phone's period control — Today, Week, Month, Year, or a range you pick.
 *
 * ── WHY PRESETS AND NOT THE DESKTOP'S DATE PICKER ───────────────────────────
 *
 * The desktop dashboard opens with two date fields, which is right at a desk:
 * the question there is usually a specific one about a specific fortnight. On a
 * phone the question is almost always "how are we doing", and answering it
 * through two date pickers is eight taps to say "this month".
 *
 * So the four periods somebody actually asks for are one tap each, and the
 * arbitrary range they occasionally want is behind the fifth. Custom is a
 * segment rather than a separate button because it IS one of the choices — a
 * control that shows four options plus a stray link reads as four options and
 * something unrelated.
 *
 * ── EVERY PERIOD ENDS TODAY ─────────────────────────────────────────────────
 *
 * "Week" is this week so far, not the last seven days, and "Year" is this year
 * so far. A shopkeeper comparing today against a target means the calendar
 * period they are inside — a rolling window would put Monday's takings into
 * "last week" on a Tuesday afternoon and quietly change the figure they had
 * been watching all morning.
 */

export type PeriodKey = 'today' | 'week' | 'month' | 'year' | 'custom'

const OPTIONS = [
  { value: 'today' as const, label: 'Today' },
  { value: 'week' as const, label: 'Week' },
  { value: 'month' as const, label: 'Month' },
  { value: 'year' as const, label: 'Year' },
  { value: 'custom' as const, label: 'Custom' },
]

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The range a preset means, resolved against the browser's today.
 *
 * The clock is the reader's rather than the server's, deliberately: this picks
 * which days to ASK for, and somebody in a shop means their own Monday. The
 * figures that come back are the server's, and the server decides what falls
 * inside the dates it is given.
 */
export function rangeFor(key: Exclude<PeriodKey, 'custom'>): DateRange {
  const now = new Date()
  const to = iso(now)

  if (key === 'today') return { from: to, to }

  if (key === 'week') {
    /* Monday, because a retail week does. getDay() calls Sunday 0, so Sunday
       has to walk back six days rather than none — the off-by-one that would
       otherwise show a Sunday as a one-day week. */
    const day = now.getDay()
    const back = day === 0 ? 6 : day - 1
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    return { from: iso(monday), to }
  }

  if (key === 'year') return { from: iso(new Date(now.getFullYear(), 0, 1)), to }

  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to }
}

/** What the chosen period is called, for the line under a headline figure. */
export function periodLabel(key: PeriodKey, range: DateRange): string {
  if (key === 'today') return 'Today'
  if (key === 'week') return 'This week'
  if (key === 'month') return 'This month'
  if (key === 'year') return 'This year'

  const from = new Date(`${range.from}T00:00:00`)
  const to = new Date(`${range.to}T00:00:00`)
  const sameYear = from.getFullYear() === to.getFullYear()
  const day = (d: Date, withYear: boolean) =>
    d.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
    })
  return `${day(from, !sameYear)} – ${day(to, true)}`
}

export function PhonePeriod({
  period,
  range,
  onChange,
}: {
  period: PeriodKey
  range: DateRange
  onChange: (period: PeriodKey, range: DateRange) => void
}) {
  const [picking, setPicking] = useState(false)
  /* The modal edits a copy, so backing out of it leaves the dashboard on the
     period it was already showing rather than on a half-typed date. */
  const [draft, setDraft] = useState<DateRange>(range)

  return (
    <>
      <SegmentedControl
        options={OPTIONS}
        value={period}
        size="touch-sm"
        aria-label="Sales period"
        onChange={(next) => {
          if (next === 'custom') {
            setDraft(range)
            setPicking(true)
            return
          }
          onChange(next, rangeFor(next))
        }}
      />

      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title="Choose a period"
        description="Both days are included in the figures."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPicking(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onChange('custom', draft)
                setPicking(false)
              }}
            >
              Show these dates
            </Button>
          </>
        }
      >
        <DateRangeField label="Sales period" value={draft} onChange={setDraft} />
      </Modal>
    </>
  )
}
