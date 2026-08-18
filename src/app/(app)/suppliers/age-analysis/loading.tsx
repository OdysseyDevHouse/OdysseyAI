import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Payables age analysis screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-64" action={false}>
      <StatStripSkeleton tiles={4} hint />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={3} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
