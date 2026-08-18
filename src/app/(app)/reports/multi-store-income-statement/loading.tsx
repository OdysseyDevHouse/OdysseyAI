import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Multi-store profit and loss screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-64" action={false}>
      <StatStripSkeleton tiles={4} />
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={3} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
