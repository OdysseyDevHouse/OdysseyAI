import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Collections screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <StatStripSkeleton tiles={4} hint />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
