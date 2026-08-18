import { Card, PageSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Commission screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={3} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
