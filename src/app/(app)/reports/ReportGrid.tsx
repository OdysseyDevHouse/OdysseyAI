'use client'

import { useMemo, useState } from 'react'
import {
  EmptyState,
  Icons,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
} from '@/components/ui'
import { formatCell } from '@/lib/reportBuilder/format'
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
 */
export default function ReportGrid({
  columns,
  rows,
  totals,
  emptyHint,
}: {
  columns: ReportColumn[]
  rows: Record<string, unknown>[]
  totals: Record<string, number>
  emptyHint?: string
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

  /*
   * Where the "N rows" label goes: the first column that carries no total.
   *
   * Was `i === 0`, which assumed the leftmost column is never a totalled one.
   * That held while column order came only from the spec, where a grouping or a
   * label leads. It stops holding once a store may reorder its own columns —
   * put a money column first and the row count had nowhere to render, so it
   * silently disappeared. Undefined when every column totals, in which case the
   * footer is all figures and there is nowhere for the label to go anyway.
   */
  const rowCountKey = columns.find((c) => !c.total)?.key

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
          {sorted.map((row, i) => (
            <tr key={i} className="border-b border-border last:border-0 hover:bg-surface-2">
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
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr className="border-t-2 border-border bg-surface-2 font-semibold text-ink">
              {columns.map((col) => (
                <td key={col.key} className={`${TABLE_TD} ${col.numeric ? TABLE_NUMERIC : ''}`}>
                  {col.key === rowCountKey
                    ? `${rows.length} row${rows.length === 1 ? '' : 's'}`
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
