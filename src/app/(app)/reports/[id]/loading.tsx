import { Card, PageSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the reports screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={3} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
