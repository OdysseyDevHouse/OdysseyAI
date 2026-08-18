import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Suppliers screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <StatStripSkeleton tiles={2} hint />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={8} rows={10} tile />
      </Card>
    </PageSkeleton>
  )
}
