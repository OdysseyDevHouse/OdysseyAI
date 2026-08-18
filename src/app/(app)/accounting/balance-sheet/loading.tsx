import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Balance sheet screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <StatStripSkeleton tiles={4} hint />
      <Card>
        <TableSkeleton columns={4} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
