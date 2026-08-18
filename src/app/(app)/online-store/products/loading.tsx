import { Card, PageSkeleton, Skeleton, ToolbarSkeleton } from '@/components/ui'

/**
 * Holds the online product visibility screen's shape while it loads.
 *
 * Not a TableSkeleton: this list is a <ul> of two-line rows, each a tile, a
 * description over a code, and a switch on the right. A table skeleton here
 * would be the wrong shape AND the wrong height.
 */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      {/* Free-standing above its card, so no `inCard` band — matching the real
          toolbar, which carries search, a department select and a segmented
          control. */}
      <ToolbarSkeleton controls={3} actions={0} inCard={false} />
      <Card>
        <div aria-hidden className="flex items-center justify-between gap-4 border-b border-border px-4 py-3.5">
          <div className="min-w-0">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="mt-1.5 h-3 w-72" />
          </div>
          <Skeleton className="h-6 w-32 rounded-pill" />
        </div>
        <ul aria-hidden className="divide-y divide-border">
          {Array.from({ length: 10 }, (_, i) => (
            /* px-4 py-1.5 and a 36px tile — the same rhythm the real row uses. */
            <li key={i} className="flex items-center gap-3 px-4 py-1.5">
              <Skeleton className="size-9 shrink-0" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-5 w-64" />
                <Skeleton className="mt-0.5 h-4 w-40" />
              </div>
              {/* The Switch, which is what sets the row's right edge. */}
              <Skeleton className="h-6 w-11 shrink-0 rounded-pill" />
            </li>
          ))}
        </ul>
      </Card>
    </PageSkeleton>
  )
}
