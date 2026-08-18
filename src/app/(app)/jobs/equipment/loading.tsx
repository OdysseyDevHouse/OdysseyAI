import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Equipment screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <StatStripSkeleton tiles={1} hint />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
