import { Card, PageBody, Skeleton, TableSkeleton } from '@/components/ui'

/** Keeps the journals list's shape while the batches load. */
export default function Loading() {
  return (
    <>
      {/* PageHeader-shaped: same border and padding, so nothing shifts. */}
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-control w-32" />
      </div>
      <PageBody>
        <Skeleton className="h-control w-80" />
        <Card>
          <TableSkeleton columns={5} rows={10} />
        </Card>
      </PageBody>
    </>
  )
}
