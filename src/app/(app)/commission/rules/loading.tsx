import { Card, PageSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Commission rules screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false} back>
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
