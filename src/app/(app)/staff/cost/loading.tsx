import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton, ToolbarSkeleton } from '@/components/ui'

/** Holds the Cost per employee screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <StatStripSkeleton tiles={4} hint />
      <Card>
        <ToolbarSkeleton />
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
