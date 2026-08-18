import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Cashbook screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28">
      <StatStripSkeleton tiles={4} hint />
      <Card>
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
