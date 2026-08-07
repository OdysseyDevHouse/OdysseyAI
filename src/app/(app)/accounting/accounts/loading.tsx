import { Card, PageBody, Skeleton, TableSkeleton } from '@/components/ui'

/** Keeps the chart of accounts' shape while the balances load. */
export default function Loading() {
  return (
    <>
      {/* PageHeader-shaped: same border and padding, so nothing shifts. */}
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-control w-36" />
      </div>
      <PageBody>
        <Skeleton className="h-control w-96" />
        <Card>
          <TableSkeleton columns={4} rows={12} />
        </Card>
      </PageBody>
    </>
  )
}
