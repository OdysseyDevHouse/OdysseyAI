import { formatMoney, formatQty } from '../decimals'
import type { ColumnType, ReportColumn } from './spec'

/**
 * Turning a report cell into text.
 *
 * Client-safe and shared by the grid, the CSV export and the scheduled email,
 * so a figure cannot read one way on screen and another in the inbox — which is
 * exactly the kind of discrepancy that makes people stop trusting a report.
 */

/** A cell as the user should read it. */
export function formatCell(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined || value === '') return ''

  switch (type) {
    case 'currency':
      return formatMoney(value)
    case 'percent': {
      const n = Number(value)
      return Number.isFinite(n) ? `${n.toFixed(1)}%` : ''
    }
    case 'number':
      return formatQty(value)
    case 'date':
      return formatDate(value)
    case 'datetime':
      return formatDateTime(value)
    default:
      return String(value)
  }
}

/**
 * A cell as a spreadsheet should receive it — numbers stay NUMBERS.
 *
 * A column of "R1 234.56" strings cannot be summed, and summing a column is the
 * first thing anyone does with an exported report.
 */
export function exportCell(value: unknown, type: ColumnType): string | number | null {
  if (value === null || value === undefined || value === '') return null
  if (type === 'currency' || type === 'number' || type === 'percent') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  if (type === 'date') return formatDate(value)
  if (type === 'datetime') return formatDateTime(value)
  return String(value)
}

/**
 * Dates arrive from the driver either as a JS Date (a real DATE/DATETIME
 * column) or as a preformatted string (the time-bucket fields, which are
 * deliberately formatted in SQL). Both have to render the same.
 */
function formatDate(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  const s = String(value)
  // Already yyyy-mm-dd (or yyyy-mm, or a bucket label) — leave it alone.
  return s.length > 10 ? s.slice(0, 10) : s
}

function formatDateTime(value: unknown): string {
  if (value instanceof Date) {
    return `${formatDate(value)} ${pad(value.getHours())}:${pad(value.getMinutes())}`
  }
  return String(value).replace('T', ' ').slice(0, 16)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Whether a column's footer total should be shown at all. */
export function formatTotal(value: number | undefined, column: ReportColumn): string {
  if (value === undefined || !column.total) return ''
  return formatCell(value, column.type)
}
