import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the commission screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" back>
      <StatStripSkeleton tiles={4} hint />
      <Card>
        <TableSkeleton columns={7} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
