import type { ReactNode } from 'react'
import { Search } from './icons'

/**
 * EmptyState — what a list shows instead of rows.
 *
 * Always say what is missing AND what to do next; a bare "No results" leaves
 * the user stuck. DataTable renders this automatically when rows is empty.
 */
export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string
  hint?: string
  icon?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-3 text-faint">{icon ?? <Search size={28} strokeWidth={1.75} />}</div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
