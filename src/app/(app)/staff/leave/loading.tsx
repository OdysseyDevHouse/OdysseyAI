import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Leave screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      <StatStripSkeleton tiles={1} hint />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
