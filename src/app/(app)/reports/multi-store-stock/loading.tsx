import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, TabsSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Stock across stores screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <StatStripSkeleton tiles={4} hint />
      <TabsSkeleton />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
