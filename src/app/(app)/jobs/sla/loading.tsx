import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Service targets screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <StatStripSkeleton tiles={4} hint />
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
