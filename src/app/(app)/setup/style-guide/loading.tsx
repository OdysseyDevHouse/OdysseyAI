import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, TabsSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the style-guide screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false}>
      <StatStripSkeleton tiles={5} hint />
      <TabsSkeleton />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={8} rows={10} tile />
      </Card>
    </PageSkeleton>
  )
}
