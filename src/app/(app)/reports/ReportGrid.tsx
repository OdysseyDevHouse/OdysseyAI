'use client'

import { Fragment, useMemo, useState } from 'react'
import {
  EmptyState,
  Icons,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
} from '@/components/ui'
import { formatCell } from '@/lib/reportBuilder/format'
import { buildSections, isGrouped, rowCountKeyFor } from '@/lib/reportBuilder/shape'
import type { ReportColumn } from '@/lib/reportBuilder/spec'

/**
 * The report grid.
 *
 * Hand-built rather than DataTable because the columns are not known until the
 * report runs, and because a report needs a TOTALS row — neither of which
 * DataTable expresses. It wears the shared table skin (TABLE_TH, TABLE_TD, …)
 * so it cannot drift from every other table in the app.
 *
 * Sorting is client-side and deliberately so: the server already capped the
 * rows, they are all in memory, and a round trip to reorder 200 rows someone is
 * staring at feels broken.
 *
 * BANDING comes from lib/reportBuilder/shape.ts rather than being worked out
 * here, so the PDF and the spreadsheet band the same rows the same way and
 * subtotal them with the same arithmetic. Sorting happens FIRST and banding
 * second, so the user's chosen order applies within each band.
 */
export default function ReportGrid({
  columns,
  rows,
  totals,
  emptyHint,
  groupKey = null,
}: {
  columns: ReportColumn[]
  rows: Record<string, unknown>[]
  totals: Record<string, number>
  emptyHint?: string
  /** The store's banding choice. Null renders one flat table, as before. */
  groupKey?: string | null
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = a[sort.key]
      const y = b[sort.key]
      // An empty cell is never the top result, whichever way the column points.
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      if (col?.numeric) return (Number(x) - Number(y)) * dir
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir
    })
  }, [rows, sort, columns])

  // Banded after sorting, so the order the user chose applies inside each band.
  const sections = useMemo(
    () => buildSections(sorted, columns, groupKey),
    [sorted, columns, groupKey],
  )

  if (columns.length === 0 || rows.length === 0) {
    return (
      <EmptyState
        title="Nothing to report"
        hint={emptyHint ?? 'No records matched this report over the period selected.'}
        icon={<Icons.BarChart size={28} strokeWidth={1.75} />}
      />
    )
  }

  const hasTotals = columns.some((c) => c.total)
  const grouped = isGrouped(sections)

  /*
   * Where the "N rows" label goes: the first column that carries no total.
   *
   * Was `i === 0`, which assumed the leftmost column is never a totalled one.
   * That held while column order came only from the spec, where a grouping or a
   * label leads. It stops holding once a store may reorder its own columns —
   * put a money column first and the row count had nowhere to render, so it
   * silently disappeared. Undefined when every column totals, in which case the
   * footer is all figures and there is nowhere for the label to go anyway.
   *
   * Shared with the PDF and the spreadsheet, so they cannot re-learn this.
   */
  const rowCountKey = rowCountKeyFor(columns)

  function toggleSort(key: string) {
    setSort((s) =>
      s?.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : // Numbers are nearly always wanted biggest-first; text A–Z.
          { key, dir: columns.find((c) => c.key === key)?.numeric ? 'desc' : 'asc' },
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`${TABLE_TH} ${col.numeric ? TABLE_NUMERIC : ''} whitespace-nowrap`}
                aria-sort={
                  sort?.key === col.key
                    ? sort.dir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                <button
                  type="button"
                  onClick={() => toggleSort(col.key)}
                  title={col.hint}
                  className={`inline-flex items-center gap-1 hover:text-ink ${
                    col.numeric ? 'flex-row-reverse' : ''
                  }`}
                >
                  {col.label}
                  {sort?.key === col.key ? (
                    sort.dir === 'asc' ? (
                      <Icons.ChevronUp size={13} />
                    ) : (
                      <Icons.ChevronDown size={13} />
                    )
                  ) : (
                    <Icons.SortNeutral size={13} className="text-faint" />
                  )}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map((section, s) => (
            <Fragment key={section.label ?? s}>
              {/* The band heading. Carries its row count, because "how many
                  card sales" is half of what banding is asked for. */}
              {section.label !== null && (
                <tr className="border-b border-border bg-surface-2">
                  <td
                    colSpan={columns.length}
                    className={`${TABLE_TD} font-semibold text-ink`}
                  >
                    {section.label}{' '}
                    <span className="font-normal text-muted">({section.rows.length})</span>
                  </td>
                </tr>
              )}

              {section.rows.map((row, i) => (
                <tr key={i} className="border-b border-border hover:bg-surface-2">
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`${TABLE_TD} ${col.numeric ? TABLE_NUMERIC : ''} ${
                        col.numeric && Number(row[col.key]) < 0 ? 'text-danger' : ''
                      }`}
                    >
                      {formatCell(row[col.key], col.type)}
                    </td>
                  ))}
                </tr>
              ))}

              {/* A band's subtotal. Only when banded — an unbanded report ends
                  with the grand total in the footer, and printing the same
                  figures twice under two names reads as a discrepancy. */}
              {grouped && section.subtotal && (
                <tr className="border-b border-border bg-surface-2/60 font-medium text-ink">
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`${TABLE_TD} ${col.numeric ? TABLE_NUMERIC : ''}`}
                    >
                      {col.key === rowCountKey
                        ? 'Total'
                        : col.total
                          ? formatCell(section.subtotal![col.key], col.type)
                          : ''}
                    </td>
                  ))}
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr className="border-t-2 border-border bg-surface-2 font-semibold text-ink">
              {columns.map((col) => (
                <td key={col.key} className={`${TABLE_TD} ${col.numeric ? TABLE_NUMERIC : ''}`}>
                  {col.key === rowCountKey
                    ? // Banded, the closing row is the total OF the bands and
                      // says so; flat, it is the only summary line and the row
                      // count is the more useful thing to put there.
                      grouped
                      ? `Grand total (${rows.length})`
                      : `${rows.length} row${rows.length === 1 ? '' : 's'}`
                    : col.total
                      ? formatCell(totals[col.key], col.type)
                      : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
