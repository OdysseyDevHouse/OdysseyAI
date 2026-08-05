'use client'

import { useId } from 'react'
import { Menu, MenuItem, MenuSeparator } from './Menu'
import { CalendarRange } from './icons'
import { CONTROL, CONTROL_H } from './styles'

/**
 * A from/to date pair with the presets people actually ask for.
 *
 * Two native date inputs rather than a calendar widget of our own. A date
 * picker is a genuinely large component — locale, keyboard grid, month
 * paging — and the native control already handles all of it, matches whatever
 * the till operator's OS is set to, and needs no JavaScript to work.
 *
 * The presets are the point: nobody wants to pick "the 1st" by hand every
 * morning, and "this month" is what a statement run or a sales report means
 * nine times out of ten.
 */
export type DateRange = { from: string; to: string }

export function DateRangeField({
  value,
  onChange,
  label = 'Date range',
  className = '',
}: {
  /** ISO yyyy-mm-dd strings, matching what <input type="date"> reads and writes. */
  value: DateRange
  onChange: (next: DateRange) => void
  label?: string
  className?: string
}) {
  const fromId = useId()
  const toId = useId()

  return (
    <div className={`flex items-end gap-2 ${className}`}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fromId} className="text-[13px] text-muted">
          {label}
        </label>
        <input
          id={fromId}
          type="date"
          value={value.from}
          max={value.to || undefined}
          onChange={(event) => onChange({ ...value, from: event.target.value })}
          className={`${CONTROL} ${CONTROL_H} w-40`}
        />
      </div>

      <span className="pb-2.5 text-sm text-faint">to</span>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={toId} className="sr-only">
          {label} end
        </label>
        <input
          id={toId}
          type="date"
          value={value.to}
          min={value.from || undefined}
          onChange={(event) => onChange({ ...value, to: event.target.value })}
          className={`${CONTROL} ${CONTROL_H} w-40`}
        />
      </div>

      <div className="pb-0">
        <Menu
          label={
            <>
              <CalendarRange size={15} />
              Presets
            </>
          }
        >
          {PRESETS.map((preset) =>
            preset.separator ? (
              <MenuSeparator key={preset.label} />
            ) : (
              <MenuItem key={preset.label} onClick={() => onChange(preset.range())}>
                {preset.label}
              </MenuItem>
            ),
          )}
        </Menu>
      </div>
    </div>
  )
}

/** Local-time yyyy-mm-dd. toISOString() would shift the date across UTC midnight. */
function iso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function range(from: Date, to: Date): DateRange {
  return { from: iso(from), to: iso(to) }
}

type Preset = { label: string; separator?: false; range: () => DateRange }
type Separator = { label: string; separator: true; range?: never }

/* Ordered shortest-to-longest, with the month boundaries last: that is the
   order people scan for, and "this month" is the one they pick most. */
const PRESETS: (Preset | Separator)[] = [
  {
    label: 'Today',
    range: () => {
      const today = new Date()
      return range(today, today)
    },
  },
  {
    label: 'Yesterday',
    range: () => {
      const day = new Date()
      day.setDate(day.getDate() - 1)
      return range(day, day)
    },
  },
  {
    label: 'Last 7 days',
    range: () => {
      const to = new Date()
      const from = new Date()
      from.setDate(from.getDate() - 6)
      return range(from, to)
    },
  },
  {
    label: 'Last 30 days',
    range: () => {
      const to = new Date()
      const from = new Date()
      from.setDate(from.getDate() - 29)
      return range(from, to)
    },
  },
  { label: 'sep-months', separator: true },
  {
    label: 'This month',
    range: () => {
      const today = new Date()
      return range(new Date(today.getFullYear(), today.getMonth(), 1), today)
    },
  },
  {
    label: 'Last month',
    range: () => {
      const today = new Date()
      // Day 0 of this month is the last day of the previous one.
      return range(
        new Date(today.getFullYear(), today.getMonth() - 1, 1),
        new Date(today.getFullYear(), today.getMonth(), 0),
      )
    },
  },
  {
    label: 'This year',
    range: () => {
      const today = new Date()
      return range(new Date(today.getFullYear(), 0, 1), today)
    },
  },
]
