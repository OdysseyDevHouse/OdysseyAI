'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { EmptyState } from './EmptyState'
import { SortAsc, SortDesc, SortNeutral } from './icons'
import { TABLE, TABLE_HEAD_ROW, TABLE_NUMERIC, TABLE_ROW, TABLE_TD, TABLE_TH } from './styles'

export type SortDirection = 'asc' | 'desc'
export type SortState = { key: string; direction: SortDirection }

export type Column<T> = {
  /** Stable id — also the sort key reported to onSortChange. */
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** Numbers, money and quantities: right-aligned with tabular figures. */
  numeric?: boolean
  sortable?: boolean
  /**
   * What to order this column by. Give it whenever the cell renders anything
   * other than a plain string or number — the fallback reads the cell, and it
   * can only sort what it can read.
   */
  sortValue?: (row: T) => string | number
  /** A tailwind width class, e.g. 'w-40'. Omit to let the column size itself. */
  width?: string
}

/**
 * DataTable — every list in OdysseyAI.
 *
 * Sorting is optional and works two ways: pass `sort` + `onSortChange` to drive
 * it yourself (server-side sorting, URL state), or leave both off and the table
 * sorts its own rows. Row actions render right-aligned in a trailing column.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  actions,
  sort,
  onSortChange,
  empty,
  onRowClick,
}: {
  columns: readonly Column<T>[]
  rows: readonly T[]
  getRowKey: (row: T) => string | number
  /** Inline row actions — use size="sm" iconOnly buttons. */
  actions?: (row: T) => ReactNode
  sort?: SortState
  onSortChange?: (next: SortState) => void
  empty?: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }
  onRowClick?: (row: T) => void
}) {
  const [internalSort, setInternalSort] = useState<SortState | undefined>(undefined)

  // Controlled when the caller passes both; uncontrolled otherwise.
  const controlled = sort !== undefined && onSortChange !== undefined
  const activeSort = controlled ? sort : internalSort

  const sortedRows = useMemo(() => {
    if (controlled || !activeSort) return rows
    const column = columns.find((c) => c.key === activeSort.key)
    if (!column) return rows

    // Sort on the rendered value, so what the user sees is what gets ordered.
    const factor = activeSort.direction === 'asc' ? 1 : -1
    const read = column.sortValue ?? ((row: T) => sortValue(column.cell(row)))
    return [...rows].sort((a, b) => {
      const left = read(a)
      const right = read(b)
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor
      return String(left).localeCompare(String(right), undefined, { numeric: true }) * factor
    })
  }, [rows, columns, activeSort, controlled])

  function toggleSort(key: string) {
    const next: SortState =
      activeSort?.key === key
        ? { key, direction: activeSort.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' }
    if (controlled) onSortChange(next)
    else setInternalSort(next)
  }

  if (rows.length === 0 && empty) {
    return <EmptyState title={empty.title} hint={empty.hint} icon={empty.icon} action={empty.action} />
  }

  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            {columns.map((column) => {
              const sorted = activeSort?.key === column.key
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sorted ? (activeSort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={`${TABLE_TH} ${column.numeric ? 'text-right' : ''} ${
                    column.width ?? ''
                  }`}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={`inline-flex items-center gap-1 transition hover:text-ink ${
                        column.numeric ? 'flex-row-reverse' : ''
                      } ${sorted ? 'text-ink' : ''}`}
                    >
                      {column.header}
                      <SortGlyph direction={sorted ? activeSort.direction : undefined} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              )
            })}
            {actions && <th scope="col" className="w-px px-4 py-2.5" />}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr
              key={getRowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`${TABLE_ROW} ${onRowClick ? 'cursor-pointer' : ''}`}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`${TABLE_TD} ${column.numeric ? TABLE_NUMERIC : ''}`}
                >
                  {column.cell(row)}
                </td>
              ))}
              {actions && (
                <td className="px-4 py-3">
                  {/* Stop clicks on an action from also triggering onRowClick. */}
                  <div
                    className="flex items-center justify-end gap-1.5"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {actions(row)}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SortGlyph({ direction }: { direction?: SortDirection }) {
  if (direction === 'asc') return <SortAsc size={13} />
  if (direction === 'desc') return <SortDesc size={13} />
  return <SortNeutral size={13} className="text-faint" />
}

/* A whole cell that is nothing but a number, optionally with a currency symbol
   in front: "R 14,99", "-1 234.50", "38". Deliberately strict — "Coca-Cola
   500ml" must stay a string, or products would sort by the 500. */
const NUMERIC_CELL = /^\s*[^\d\s]{0,3}\s*-?[\d\s]+(?:[.,]\d+)?\s*$/

/** Best-effort sort key for a cell the caller didn't give a sortValue for. */
function sortValue(node: ReactNode): string | number {
  if (typeof node === 'number') return node
  if (typeof node !== 'string') return ''
  if (!NUMERIC_CELL.test(node)) return node

  // Drop the currency symbol and thousands spaces; treat a comma as the
  // decimal separator, which is how ZA money is written.
  const parsed = Number(node.replace(/[^\d,.-]/g, '').replace(',', '.'))
  return Number.isNaN(parsed) ? node : parsed
}
