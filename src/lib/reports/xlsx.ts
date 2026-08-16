import 'server-only'
import * as XLSX from 'xlsx'
import { exportCell } from '../reportBuilder/format'
import { isGrouped, rowCountKeyFor, type ReportSection } from '../reportBuilder/shape'
import type { ColumnType, ReportColumn } from '../reportBuilder/spec'

/**
 * A report as a workbook, banded the way the screen bands it.
 *
 * ── WHY NOT lib/export/table.ts ──────────────────────────────────────────
 *
 * toXlsx() there writes a header row and then rows, which is right for the
 * dozen lists across the app that use it. A report needs a title block, band
 * headings, a subtotal under each band and a grand total under the lot — and
 * bending a helper that half the app depends on into expressing all that would
 * make every other caller pay for it. So: a report-specific renderer, beside
 * the report-specific PDF, both fed by the same sections.
 *
 * ── NUMBERS STAY NUMBERS ─────────────────────────────────────────────────
 *
 * Every numeric cell is written as a NUMBER carrying a display format, never as
 * "R1 234.56". A column of formatted strings cannot be summed, and summing a
 * column is the first thing anyone does with an exported report. (The system
 * this was modelled on writes strings, which is why its "Excel" export cannot
 * be pivoted. Not copied.)
 *
 * A blank numeric cell stays BLANK rather than becoming 0 — an empty cell must
 * never read as a zero in a column someone is about to total.
 */

/**
 * Excel number formats by column type.
 *
 * Percent columns hold 12.5 meaning 12.5%, so the format appends a literal sign
 * rather than using Excel's own `%`, which would multiply by 100 on display.
 */
const NUMBER_FORMATS: Partial<Record<ColumnType, string>> = {
  currency: '#,##0.00',
  number: '#,##0.###',
  percent: '#,##0.00"%"',
}

export interface ReportRender {
  title: string
  subtitle?: string
  /** The store this was run for, for a file that outlives the screen. */
  storeName?: string
  range: { from: string; to: string }
  columns: ReportColumn[]
  sections: ReportSection[]
  grandTotal: Record<string, number>
  rowCount: number
  /** The engine's row cap cut the result — every figure below is partial. */
  truncated: boolean
  /** Columns this role may not see, named so the reader knows what is missing. */
  hiddenColumns: string[]
}

export function renderReportXlsx(report: ReportRender): Buffer {
  const { columns } = report
  const grouped = isGrouped(report.sections)
  const labelKey = rowCountKeyFor(columns)
  const aoa: unknown[][] = []

  /* A title block, so a file detached from the screen still says what it is. */
  aoa.push([report.title])
  if (report.subtitle) aoa.push([report.subtitle])
  if (report.storeName) aoa.push([report.storeName])
  aoa.push([`Period: ${periodLabel(report.range)}`])
  aoa.push([])

  const headerRow = aoa.length
  aoa.push(columns.map((c) => c.label))

  for (const section of report.sections) {
    if (section.label !== null) {
      aoa.push([`${section.label} (${section.rows.length})`])
    }
    for (const row of section.rows) {
      aoa.push(columns.map((col) => exportCell(row[col.key], col.type) ?? ''))
    }
    // Only when banded: an unbanded sheet closes with the grand total, and the
    // same figures under two names read as a discrepancy.
    if (grouped && section.subtotal) {
      aoa.push(totalsRow(columns, section.subtotal, 'Total', labelKey))
    }
  }

  aoa.push([])
  aoa.push(totalsRow(columns, report.grandTotal, 'Grand total', labelKey))

  const notes = footnotes(report)
  if (notes.length > 0) {
    aoa.push([])
    for (const note of notes) aoa.push([note])
  }

  const sheet = XLSX.utils.aoa_to_sheet(aoa)
  applyNumberFormats(sheet, columns, aoa.length)
  sheet['!cols'] = columns.map((c) => ({ wch: columnWidth(c, report) }))
  // Freeze the header so a long report stays readable while scrolling.
  sheet['!freeze'] = { xSplit: 0, ySplit: headerRow + 1 }

  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, sheetName(report.title))
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/* ── pieces ────────────────────────────────────────────────────────────────── */

export function periodLabel(range: { from: string; to: string }): string {
  return range.from === range.to ? range.from : `${range.from} to ${range.to}`
}

/**
 * The notes under the table: what was cut, and what this role could not see.
 *
 * Shared with the PDF so a reader is told the same thing whichever file they
 * opened — a truncated report that says so in one format and not the other is
 * how two people end up arguing about different numbers.
 */
export function footnotes(report: ReportRender): string[] {
  const notes: string[] = [`${report.rowCount.toLocaleString('en-ZA')} rows`]
  if (report.truncated) {
    notes.push('the report hit its row cap, so these figures cover only the rows shown')
  }
  if (report.hiddenColumns.length > 0) {
    notes.push(`columns your role cannot see: ${report.hiddenColumns.join(', ')}`)
  }
  return notes
}

/**
 * A totals row. The label goes in the first column that carries no total, for
 * the reason ReportGrid gives: a store may reorder its columns, and putting the
 * word "Total" on top of a figure loses the figure.
 */
function totalsRow(
  columns: readonly ReportColumn[],
  totals: Record<string, number>,
  label: string,
  labelKey: string | undefined,
): unknown[] {
  return columns.map((col, i) => {
    if (labelKey === undefined ? i === 0 : col.key === labelKey) return label
    if (!col.total) return ''
    const v = totals[col.key]
    return v === null || v === undefined ? '' : v
  })
}

/** Stamp `z` number formats on every numeric cell in the sheet. */
function applyNumberFormats(
  sheet: XLSX.WorkSheet,
  columns: readonly ReportColumn[],
  rowCount: number,
): void {
  columns.forEach((col, c) => {
    const fmt = NUMBER_FORMATS[col.type]
    if (!fmt) return
    for (let r = 0; r < rowCount; r++) {
      const ref = XLSX.utils.encode_cell({ r, c })
      const cell = sheet[ref] as XLSX.CellObject | undefined
      if (cell && cell.t === 'n') cell.z = fmt
    }
  })
}

/** A width that fits the header and typical values, within sane bounds. */
function columnWidth(col: ReportColumn, report: ReportRender): number {
  let widest = col.label.length
  let seen = 0
  for (const section of report.sections) {
    for (const row of section.rows) {
      const v = row[col.key]
      if (v !== null && v !== undefined) widest = Math.max(widest, String(v).length)
      if (++seen >= 50) break
    }
    if (seen >= 50) break
  }
  return Math.min(42, Math.max(10, widest + 2))
}

/** Excel caps sheet names at 31 characters and rejects : \ / ? * [ ]. */
function sheetName(title: string): string {
  const clean = title.replace(/[:\\/?*[\]]/g, ' ').trim()
  return clean.slice(0, 31) || 'Report'
}
