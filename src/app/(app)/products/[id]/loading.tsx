import { Card, PageSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Edit product screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" back>
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={5} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
