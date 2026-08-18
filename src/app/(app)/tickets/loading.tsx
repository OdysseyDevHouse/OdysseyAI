import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Tickets screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28">
      <StatStripSkeleton tiles={3} />
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
