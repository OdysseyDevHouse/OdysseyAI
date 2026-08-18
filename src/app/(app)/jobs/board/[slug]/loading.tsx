import { PageSkeleton, Skeleton } from '@/components/ui'

/**
 * Holds the job board's shape while its columns load.
 *
 * Its own file because the board would otherwise inherit /jobs' TABLE
 * skeleton — a list of rows standing in for a horizontal row of columns, which
 * is the wrong shape in the most visible possible way.
 *
 * `w-72` and `gap-3` mirror Column's own classes, so the columns land where
 * the real ones do.
 */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <div aria-hidden className="flex gap-3 overflow-x-auto pb-2">
        {Array.from({ length: 4 }, (_, c) => (
          <div
            key={c}
            className="flex w-72 shrink-0 flex-col rounded-card border border-border bg-surface-2"
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-6 rounded-pill" />
            </div>
            {/* Varying card counts per column: a board with four identical
                stacks reads as a grid, which is not what a board looks like. */}
            <div className="flex flex-col gap-2 p-2">
              {Array.from({ length: [4, 2, 3, 1][c] ?? 2 }, (_, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-1.5 rounded-control border border-border bg-surface p-2.5"
                >
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PageSkeleton>
  )
}
