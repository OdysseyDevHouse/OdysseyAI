/**
 * Billing period arithmetic.
 *
 * Pure, and deliberately free of any server import: the billing screen shows
 * the customer the date a downgrade will land, and the action then writes it.
 * If those were two implementations they would eventually disagree, and the
 * disagreement would be invisible until somebody lost a day they had paid for.
 */

/** ISO date (YYYY-MM-DD) for a Date, read in UTC. */
function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * A day of the month that exists in every month.
 *
 * 29, 30 and 31 are clamped to 28. A billing day of the 31st would skip
 * February, and a downgrade scheduled for a date that never arrives is a module
 * the customer keeps being charged for after they cancelled it.
 */
export function safeBillingDay(day: number): number {
  if (!Number.isFinite(day)) return 1
  return Math.min(28, Math.max(1, Math.floor(day)))
}

/**
 * The last day of the period `today` falls in — the day before the next
 * occurrence of `billingDay`.
 *
 * Billing day 1, today 12 August  -> 31 August (the month runs 1–31)
 * Billing day 15, today 12 August -> 14 August (the month runs 15–14)
 * Billing day 15, today 20 August -> 14 September
 * Billing day 15, today 15 August -> 14 September (today IS the roll-over)
 *
 * Dates are built with UTC accessors throughout. The pool reads DATE columns
 * back as strings with `timezone: 'Z'`, so a local-time reading here would put
 * the boundary in a different place depending on where the server is.
 */
export function periodEnd(todayIso: string, billingDay: number): string {
  const day = safeBillingDay(billingDay)
  const today = new Date(`${todayIso}T00:00:00Z`)

  const year = today.getUTCFullYear()
  const month = today.getUTCMonth()
  const dom = today.getUTCDate()

  /* The next time the billing day comes round. If today is before it, that is
     this month; if today is on or after it, the period has already rolled and
     the next one is next month. "On" counts as rolled: a customer downgrading
     on their billing day has just been charged for the month ahead. */
  const next =
    dom < day ? new Date(Date.UTC(year, month, day)) : new Date(Date.UTC(year, month + 1, day))

  // The day before that.
  next.setUTCDate(next.getUTCDate() - 1)
  return iso(next)
}

/**
 * The next date this account is charged — the next occurrence of `billingDay`,
 * which is simply the day after the current period ends.
 */
export function nextBillingDate(todayIso: string, billingDay: number): string {
  const end = new Date(`${periodEnd(todayIso, billingDay)}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 1)
  return iso(end)
}

/** "31 August 2026" — for the "ends on" chip and the confirm dialog. */
export function formatPeriodDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return isoDate
  return new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d)
}
