import { Card, PageSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the stock-takes screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" back>
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={5} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
