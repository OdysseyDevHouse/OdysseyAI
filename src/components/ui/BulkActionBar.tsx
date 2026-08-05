import type { ReactNode } from 'react'
import { Badge } from './Badge'

/**
 * The strip that appears above a list once rows are selected.
 *
 * Layout only — it holds no selection state. The list's client wrapper owns
 * that (see the DataTable selection props) and passes the count down, so the
 * same bar works for customers, suppliers, sales documents or anything else.
 *
 * Sticky, because a bulk action on 200 selected rows is chosen after scrolling
 * to check the selection, and an action bar that has scrolled off the top means
 * scrolling all the way back.
 */
export function BulkActionBar({
  count,
  onClear,
  children,
  selectAll,
  className = '',
}: {
  count: number
  onClear: () => void
  /** The actions. Keep three inline at most; the rest belong in a <Menu>. */
  children: ReactNode
  /**
   * Offered when the selection covers the whole page but the filter matches
   * more — "Select all 412 matching". Without it, a bulk action silently means
   * "this page only", which is the sort of surprise that costs a data repair.
   */
  selectAll?: { total: number; onSelectAll: () => void; selected: boolean }
  className?: string
}) {
  if (count === 0) return null

  return (
    <div
      className={`sticky top-0 z-10 flex flex-wrap items-center gap-3 border-y border-brand/25 bg-brand-soft px-4 py-2.5 ${className}`}
    >
      <span className="flex items-center gap-2 text-sm text-ink-2">
        <Badge tone="brand">{count}</Badge>
        selected
      </span>

      {selectAll && !selectAll.selected && selectAll.total > count && (
        <button
          type="button"
          onClick={selectAll.onSelectAll}
          /* A link-styled affordance inside a tinted bar, not a button: a
             bordered Button here reads as a fourth action competing with the
             real ones. */
          data-kit-ok
          className="text-[13px] font-medium text-brand underline underline-offset-2 transition hover:text-brand-ink"
        >
          Select all {selectAll.total} matching
        </button>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-1.5">{children}</div>

      <button
        type="button"
        onClick={onClear}
        data-kit-ok
        className="text-[13px] text-muted transition hover:text-ink"
      >
        Clear
      </button>
    </div>
  )
}
