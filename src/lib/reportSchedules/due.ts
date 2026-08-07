import type { Frequency } from '../site/reportSchedules'

/**
 * When was this rule last due?
 *
 * ── WHY THIS WALKS BACKWARDS FROM NOW ────────────────────────────────────────
 *
 * The tick asks "is there an occurrence I have not sent yet?", not "is it
 * exactly 07:00 right now?". Walking backwards from the wall clock to the most
 * recent scheduled instant means:
 *
 *   · a tick that runs at 07:00:41 still finds the 07:00 occurrence;
 *   · a tick missed entirely (deploy, outage) is picked up by the next one,
 *     rather than the send being lost;
 *   · two ticks a minute apart compute a BYTE-IDENTICAL instant, so the run
 *     ledger's UNIQUE key can recognise them as the same occurrence.
 *
 * That last point is why seconds and milliseconds are zeroed: an instant
 * derived from "now" would differ per tick and every tick would claim its own
 * row, which is exactly the double-send the ledger exists to prevent.
 *
 * Returns null when the rule has no occurrence at or before `now` — a weekly
 * rule whose day has not come round yet.
 */
export function lastDueAt(
  rule: {
    frequency: Frequency
    sendTime: string
    daysOfWeek: string
    dayOfMonth: number
  },
  now: Date,
): Date | null {
  const [hours, minutes] = parseTime(rule.sendTime)

  switch (rule.frequency) {
    case 'daily': {
      const today = at(now, hours, minutes)
      // Before today's send time, the last occurrence was yesterday's.
      return today <= now ? today : shiftDays(today, -1)
    }

    case 'weekly': {
      // Mon..Sun mask. Walk back up to 7 days for the most recent flagged day
      // whose send time has passed.
      if (!/[1]/.test(rule.daysOfWeek)) return null
      for (let back = 0; back < 8; back++) {
        const day = shiftDays(now, -back)
        const candidate = at(day, hours, minutes)
        if (candidate > now) continue
        if (rule.daysOfWeek[mondayIndex(candidate)] === '1') return candidate
      }
      return null
    }

    case 'monthly': {
      const thisMonth = monthlyOccurrence(now.getFullYear(), now.getMonth(), rule.dayOfMonth, hours, minutes)
      if (thisMonth <= now) return thisMonth
      // Before this month's send: last month's, clamped to its own length.
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      return monthlyOccurrence(prev.getFullYear(), prev.getMonth(), rule.dayOfMonth, hours, minutes)
    }
  }
}

/**
 * The next time this rule will send, for the setup screen.
 *
 * Deliberately a separate walk FORWARD rather than "last + one interval": for a
 * weekly rule on Mon/Wed/Fri the gap between occurrences is not constant, and
 * for a monthly rule on the 31st it is not even a fixed number of days.
 */
export function nextDueAt(
  rule: {
    frequency: Frequency
    sendTime: string
    daysOfWeek: string
    dayOfMonth: number
  },
  now: Date,
): Date | null {
  const [hours, minutes] = parseTime(rule.sendTime)

  switch (rule.frequency) {
    case 'daily': {
      const today = at(now, hours, minutes)
      return today > now ? today : shiftDays(today, 1)
    }

    case 'weekly': {
      if (!/[1]/.test(rule.daysOfWeek)) return null
      for (let ahead = 0; ahead < 8; ahead++) {
        const day = shiftDays(now, ahead)
        const candidate = at(day, hours, minutes)
        if (candidate <= now) continue
        if (rule.daysOfWeek[mondayIndex(candidate)] === '1') return candidate
      }
      return null
    }

    case 'monthly': {
      const thisMonth = monthlyOccurrence(now.getFullYear(), now.getMonth(), rule.dayOfMonth, hours, minutes)
      if (thisMonth > now) return thisMonth
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      return monthlyOccurrence(next.getFullYear(), next.getMonth(), rule.dayOfMonth, hours, minutes)
    }
  }
}

/**
 * The occurrence in a given month, CLAMPED to that month's last day.
 *
 * A rule set to the 31st has to fire in February, or a month-end report simply
 * never arrives in the short months — which is both surprising and the month
 * people most want it.
 */
function monthlyOccurrence(
  year: number,
  month: number,
  dayOfMonth: number,
  hours: number,
  minutes: number,
): Date {
  const lastDay = new Date(year, month + 1, 0).getDate()
  const day = Math.min(Math.max(1, dayOfMonth), lastDay)
  return new Date(year, month, day, hours, minutes, 0, 0)
}

/** The same calendar day, at the given time, with seconds and ms zeroed. */
function at(d: Date, hours: number, minutes: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes, 0, 0)
}

function shiftDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

/** Monday = 0, to match the stored Mon..Sun mask. */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

/** "07:30" -> [7, 30]. Anything unparseable falls back to 07:00. */
function parseTime(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return [7, 0]
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return [7, 0]
  return [h, min]
}

/** "Every day at 07:00", for the schedules list. */
export function describeSchedule(rule: {
  frequency: Frequency
  sendTime: string
  daysOfWeek: string
  dayOfMonth: number
}): string {
  switch (rule.frequency) {
    case 'daily':
      return `Every day at ${rule.sendTime}`
    case 'weekly': {
      const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      const days = names.filter((_, i) => rule.daysOfWeek[i] === '1')
      if (days.length === 0) return 'No days selected'
      if (days.length === 7) return `Every day at ${rule.sendTime}`
      if (days.length === 5 && rule.daysOfWeek.startsWith('11111')) {
        return `Weekdays at ${rule.sendTime}`
      }
      return `${days.join(', ')} at ${rule.sendTime}`
    }
    case 'monthly':
      return `Day ${rule.dayOfMonth} of each month at ${rule.sendTime}`
  }
}
