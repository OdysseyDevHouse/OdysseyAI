import 'server-only'
import * as XLSX from 'xlsx'

/**
 * Rows out of the app, as a spreadsheet or a CSV.
 *
 * One column definition drives both formats, so the two can never disagree
 * about what a report contains — which is the whole reason a store owner
 * opening the CSV and the accountant opening the .xlsx have the same argument
 * about the same numbers.
 *
 * Money is written as a NUMBER, not "R1 234.56". A spreadsheet column of
 * formatted strings cannot be summed, and the first thing anyone does with an
 * exported age analysis is sum a column.
 */

export type ExportColumn<T> = {
  header: string
  value: (row: T) => string | number | null
  /** Renders with a thousands separator and two decimals in Excel. */
  money?: boolean
}

export function toSheet<T>(rows: readonly T[], columns: readonly ExportColumn<T>[]): XLSX.WorkSheet {
  const data = [
    columns.map((c) => c.header),
    ...rows.map((row) => columns.map((c) => c.value(row) ?? '')),
  ]

  const sheet = XLSX.utils.aoa_to_sheet(data)

  // Number formats are applied per cell, since a sheet has no column-level
  // format. The header row is skipped, hence starting at 1.
  columns.forEach((column, columnIndex) => {
    if (!column.money) return
    for (let rowIndex = 1; rowIndex <= rows.length; rowIndex++) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })
      const cell = sheet[address]
      if (cell && typeof cell.v === 'number') cell.z = '#,##0.00'
    }
  })

  // Width from the longest value in each column, clamped so one long
  // description does not produce a column nobody can scroll past.
  sheet['!cols'] = columns.map((column, index) => ({
    wch: Math.min(
      Math.max(column.header.length, ...data.slice(1).map((r) => String(r[index] ?? '').length)) + 2,
      48,
    ),
  }))

  return sheet
}

export function toXlsx<T>(
  rows: readonly T[],
  columns: readonly ExportColumn<T>[],
  sheetName = 'Sheet1',
): Buffer {
  const book = XLSX.utils.book_new()
  // Excel refuses sheet names over 31 characters, and silently corrupts the
  // file rather than telling you.
  XLSX.utils.book_append_sheet(book, toSheet(rows, columns), sheetName.slice(0, 31))
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
}

export function toCsv<T>(rows: readonly T[], columns: readonly ExportColumn<T>[]): string {
  const lines = [
    columns.map((c) => csvCell(c.header)).join(','),
    ...rows.map((row) => columns.map((c) => csvCell(c.value(row))).join(',')),
  ]
  // CRLF and a BOM: Excel on Windows opens a plain UTF-8 CSV as mojibake, and
  // a South African customer name with an accent in it is not an edge case.
  return '﻿' + lines.join('\r\n') + '\r\n'
}

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/** A filename that sorts by date and cannot collide between two exports. */
export function exportFilename(base: string, extension: 'xlsx' | 'csv'): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  return `${base}-${stamp}.${extension}`
}
