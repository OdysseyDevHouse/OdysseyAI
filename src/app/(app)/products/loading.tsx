import { Card, PageSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the products screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={8} rows={10} tile />
      </Card>
    </PageSkeleton>
  )
}
