import { Card, PageSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Users screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={5} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
