import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Job cards screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <StatStripSkeleton tiles={5} />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={7} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
