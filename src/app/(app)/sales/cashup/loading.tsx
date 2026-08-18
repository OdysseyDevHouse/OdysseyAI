import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Cash-up screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      <StatStripSkeleton tiles={4} hint />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={7} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
