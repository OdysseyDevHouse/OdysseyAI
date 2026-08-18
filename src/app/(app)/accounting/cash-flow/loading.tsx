import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Cash flow screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false}>
      <StatStripSkeleton tiles={4} hint />
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={3} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
