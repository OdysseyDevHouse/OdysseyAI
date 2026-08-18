import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Stock takes screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <StatStripSkeleton tiles={3} hint />
      <Card>
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
