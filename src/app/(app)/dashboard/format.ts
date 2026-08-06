import { formatMoney, formatQty } from '@/lib/decimals'

/**
 * Dashboard-specific number formatting.
 *
 * The app's `formatMoney` is the house style and is used verbatim for anything
 * read as a figure — tiles, tables, tooltips. What it cannot do is fit on a
 * chart axis: "R1 234 567.00" is 14 characters, and five of those stacked up
 * the left of a chart leaves no room for the chart. Hence `moneyShort`, which
 * is for AXES AND ONLY AXES — a rounded number on a scale is honest, the same
 * rounding on a KPI tile is wrong.
 */

export { formatMoney as money, formatQty as qty }

/** "R1.2m" / "R48k" / "R950" — chart axes and other tight spaces. */
export function moneyShort(value: number): string {
  const sign = value < 0 ? '-' : ''
  const n = Math.abs(value)
  if (n >= 1_000_000) return `${sign}R${trim(n / 1_000_000)}m`
  if (n >= 1_000) return `${sign}R${trim(n / 1_000)}k`
  return `${sign}R${Math.round(n)}`
}

/** One decimal, but no trailing ".0" — "1.2" and "48", never "48.0". */
function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '')
}

/** A plain count with thousands separators, matching formatMoney's spacing. */
export function count(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

export function percent(value: number): string {
  return `${value.toFixed(1)}%`
}

/** Averages that are counts, not money — "2.4 items". */
export function decimal(value: number, places = 1): string {
  return value.toFixed(places)
}

/** "14:00" for an hour-of-day bucket. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** "12 Jun" for a yyyy-mm-dd. Parsed as UTC so it cannot drift a day. */
export function dayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}
