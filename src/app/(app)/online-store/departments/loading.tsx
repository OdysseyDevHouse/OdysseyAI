import { Card, PageSkeleton, Skeleton } from '@/components/ui'

/**
 * Holds the online department tree's shape while it loads.
 *
 * Same row rhythm as the product visibility screen beside it — a card header
 * over a divided list of switch rows — but with no toolbar above it, because
 * the tree has no search or filters.
 */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-36" action={false}>
      <Card>
        <div aria-hidden className="flex items-center justify-between gap-4 border-b border-border px-4 py-3.5">
          <div className="min-w-0">
            <Skeleton className="h-4 w-52" />
            <Skeleton className="mt-1.5 h-3 w-64" />
          </div>
          <Skeleton className="h-6 w-28 rounded-pill" />
        </div>
        <ul aria-hidden className="divide-y divide-border">
          {Array.from({ length: 8 }, (_, i) => (
            /* py-1.5 over a 25px content box gives the measured 37px row. */
            <li key={i} className="flex items-center gap-3 px-4 py-1.5">
              {/* Indent every other row: the real list is a TREE, and a flat
                  stack of equal bars would settle into an uneven one. */}
              <Skeleton className={`h-6 ${i % 3 === 0 ? 'w-48' : 'ml-6 w-40'}`} />
              <span className="flex-1" />
              <Skeleton className="h-6 w-11 shrink-0 rounded-pill" />
            </li>
          ))}
        </ul>
      </Card>
    </PageSkeleton>
  )
}
