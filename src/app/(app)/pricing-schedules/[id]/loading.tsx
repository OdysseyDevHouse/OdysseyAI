import { Card, PageSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the pricing-schedules screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={7} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
