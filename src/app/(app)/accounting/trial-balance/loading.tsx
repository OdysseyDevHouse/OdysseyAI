import { Card, PageBody, Skeleton, TableSkeleton } from '@/components/ui'

/** Keeps the trial balance's shape while the ledger is summed. */
export default function Loading() {
  return (
    <>
      {/* PageHeader-shaped: same border and padding, so nothing shifts. */}
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-control w-44" />
      </div>
      <PageBody>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2 h-7 w-32" />
            </Card>
          ))}
        </div>
        <Card>
          <TableSkeleton columns={5} rows={12} />
        </Card>
      </PageBody>
    </>
  )
}
