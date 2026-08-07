import { TABLE, TABLE_HEAD_ROW, TABLE_TD, TABLE_TH } from './styles'

/** A pulsing placeholder bar. Compose into layouts that must not collapse. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`block animate-pulse rounded-control bg-surface-2 ${className}`} />
}

/**
 * TableSkeleton — a loading table at the real row height (36px), so the page
 * keeps its shape while data loads instead of collapsing to a spinner and
 * shoving everything down when rows arrive (see odyssey-craft on loading).
 *
 * Use inside the same Card the real table will occupy, with the same column
 * count.
 */
export function TableSkeleton({ columns = 5, rows = 8 }: { columns?: number; rows?: number }) {
  return (
    <div aria-hidden className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            {Array.from({ length: columns }, (_, i) => (
              <th key={i} scope="col" className={TABLE_TH}>
                <Skeleton className="h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className="border-b border-border last:border-b-0">
              {Array.from({ length: columns }, (_, c) => (
                <td key={c} className={TABLE_TD}>
                  {/* h-5 keeps the row at TABLE_TD's real 36px rhythm. */}
                  <Skeleton className={`h-5 ${c === 0 ? 'w-32' : 'w-16'}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
