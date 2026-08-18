import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Timesheets screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false}>
      <StatStripSkeleton tiles={4} hint />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={4} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
