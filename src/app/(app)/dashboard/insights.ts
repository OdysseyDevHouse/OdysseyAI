import type { DayBucket, HourBucket } from '@/lib/site/salesDashboard'
import { money, moneyShort, count, decimal } from './format'

/**
 * The figures the dashboard DERIVES rather than fetches.
 *
 * Every number here comes out of `perDay` / `perHour`, both of which are
 * already on the wire for the charts. That is the whole reason this file is
 * arithmetic and not SQL: "turnover per trading day" is a division, and adding
 * a query for it would mean the dashboard could disagree with its own chart.
 *
 * The other half of the file is the plain-English line under each chart. A
 * chart shows the shape; the sentence says what the shape MEANS — which day was
 * best, when the shop is actually busy — and that is the part a store owner
 * repeats to their staff. It is generated from the same buckets the chart
 * plots, so it cannot describe a chart that is not there.
 */

/** A day the shop actually traded. A closed Sunday must not drag an average down. */
function trading(perDay: DayBucket[]): DayBucket[] {
  return perDay.filter((d) => d.turnover !== 0 || d.saleCount !== 0)
}

/**
 * Saturday or Sunday, read as UTC.
 *
 * The dates are yyyy-mm-dd strings and the pool runs on 'Z', so they are parsed
 * as UTC everywhere else in this app too — `new Date('2026-08-01')` in a
 * negative-offset browser is the 31st of July, and a weekend split that is
 * wrong by a day is worse than no split at all.
 */
export function isWeekend(isoDate: string): boolean {
  const [y, m, d] = isoDate.split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return day === 0 || day === 6
}

export type SecondaryStats = {
  /** Days in the range on which anything was sold. */
  tradingDays: number
  turnoverPerDay: number
  /** Hours of the day that saw a sale — the shop's real trading window. */
  tradingHours: number
  turnoverPerHour: number
  salesPerDay: number
  salesPerHour: number
  saleCount: number
}

/**
 * The second strip: the headline figures divided by the time they took.
 *
 * "R1.2m this month" and "R33 548 a day" are the same fact, and the second one
 * is the one a shop owner can act on — it is comparable against yesterday,
 * against the shop down the road, and against what the day costs to open.
 *
 * Divided by TRADING days and TRADING hours, never by the calendar. A month
 * with four public holidays did not earn less per day because the doors were
 * shut; dividing by 31 would say it did.
 */
export function secondaryStats(
  perDay: DayBucket[],
  perHour: HourBucket[],
  saleCount: number,
): SecondaryStats {
  const days = trading(perDay)
  const tradingDays = days.length
  const turnover = days.reduce((sum, d) => sum + d.turnover, 0)
  const hours = perHour.filter((h) => h.turnover !== 0 || h.saleCount !== 0)
  const tradingHours = hours.length

  return {
    tradingDays,
    turnoverPerDay: tradingDays ? turnover / tradingDays : 0,
    tradingHours,
    // Per hour of a TYPICAL day, not per hour across the whole month: the hour
    // buckets are summed over every day in the range, so dividing the range's
    // turnover by 24 * 31 would answer a question nobody asked. This is what
    // the shop takes in an average open hour.
    turnoverPerHour: tradingDays && tradingHours ? turnover / tradingDays / tradingHours : 0,
    salesPerDay: tradingDays ? saleCount / tradingDays : 0,
    salesPerHour: tradingDays && tradingHours ? saleCount / tradingDays / tradingHours : 0,
    saleCount,
  }
}

/** The mean across trading days — the dashed line on the per-day chart. */
export function dailyAverage(perDay: DayBucket[]): number {
  const days = trading(perDay)
  if (days.length === 0) return 0
  return days.reduce((sum, d) => sum + d.turnover, 0) / days.length
}

/** "Saturday 20 August" — the long form, for a sentence rather than an axis. */
function longDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-ZA', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
}

/**
 * The sentence under the per-day chart.
 *
 * Two clauses at most, and the second one only when it is TRUE — the weekend
 * comparison is dropped entirely when the range holds no weekend, rather than
 * printed as "0% ahead". A takeaway that pads itself out with non-facts is how
 * a reader learns to stop reading it.
 */
export function perDayTakeaway(perDay: DayBucket[]): string | null {
  const days = trading(perDay)
  if (days.length === 0) return null

  const best = days.reduce((a, b) => (b.turnover > a.turnover ? b : a))
  if (best.turnover <= 0) return null
  const parts = [`Best day was ${longDay(best.date)} at ${money(best.turnover)}.`]

  const weekend = days.filter((d) => isWeekend(d.date))
  const weekday = days.filter((d) => !isWeekend(d.date))
  if (weekend.length > 0 && weekday.length > 0) {
    const wkndAvg = weekend.reduce((s, d) => s + d.turnover, 0) / weekend.length
    const weekAvg = weekday.reduce((s, d) => s + d.turnover, 0) / weekday.length
    if (weekAvg > 0) {
      const diff = ((wkndAvg - weekAvg) / weekAvg) * 100
      // Under a percent either way is noise, and calling it out as "0% ahead"
      // invents a pattern the data does not have.
      if (Math.abs(diff) >= 1) {
        parts.push(
          diff > 0
            ? `Weekends run ${decimal(diff, 0)}% ahead of weekdays.`
            : `Weekends run ${decimal(Math.abs(diff), 0)}% behind weekdays.`,
        )
      }
    }
  }

  return parts.join(' ')
}

/** "7am" / "1pm" — the reference's own axis form, and how a shop says it. */
export function hour12(hour: number): string {
  if (hour === 0) return '12am'
  if (hour === 12) return '12pm'
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`
}

/**
 * The two busiest hours, far enough apart to be separate rushes.
 *
 * A plain "top two" on a smooth curve returns 10am and 11am — the same peak
 * twice — which tells a manager nothing about when to put a second person on
 * the till. Requiring a gap makes the second entry a genuinely different part
 * of the day, which is the only version worth labelling on the chart.
 */
export function peakHours(perHour: HourBucket[], gap = 2): HourBucket[] {
  const busy = perHour.filter((h) => h.turnover > 0).sort((a, b) => b.turnover - a.turnover)
  const picked: HourBucket[] = []
  for (const h of busy) {
    if (picked.length === 2) break
    if (picked.every((p) => Math.abs(p.hour - h.hour) >= gap)) picked.push(h)
  }
  return picked.sort((a, b) => a.hour - b.hour)
}

/**
 * The sentence under the per-hour chart.
 *
 * The quiet-hour clause is the one worth having: a trough BETWEEN two peaks is
 * a staffing decision, and costing it in rands per day is what turns "it goes
 * quiet after lunch" into something a manager can weigh against a shift.
 */
export function perHourTakeaway(perHour: HourBucket[], tradingDays: number): string | null {
  const peaks = peakHours(perHour)
  if (peaks.length === 0 || tradingDays === 0) return null

  const per = (h: HourBucket) => h.turnover / tradingDays
  const parts =
    peaks.length === 2
      ? [
          `Two peaks: ${hour12(peaks[0].hour)} at ${money(per(peaks[0]))} and ` +
            `${hour12(peaks[1].hour)} at ${money(per(peaks[1]))}.`,
        ]
      : [`Busiest at ${hour12(peaks[0].hour)}, taking ${money(per(peaks[0]))} an hour.`]

  if (peaks.length === 2) {
    // The dip between them, against the better of the two peaks — that gap is
    // what an extra hour of the morning rate would actually be worth.
    const between = perHour.filter((h) => h.hour > peaks[0].hour && h.hour < peaks[1].hour)
    if (between.length > 0) {
      const trough = between.reduce((a, b) => (b.turnover < a.turnover ? b : a))
      const shortfall = per(peaks[0]) - per(trough)
      if (shortfall > 0) {
        // Deliberately terse. The sentence sits in a one-line footer under the
        // chart, and the earlier, fuller phrasing ("…a day against the 7pm
        // rate") wrapped to a second line in a half-width widget — which took
        // the height straight out of the chart above it.
        parts.push(`The ${hour12(trough.hour)} dip costs about ${moneyShort(shortfall)} a day.`)
      }
    }
  }

  return parts.join(' ')
}

/** "31 trading days" / "1 trading day" — a hint that cannot say "1 days". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`
}
