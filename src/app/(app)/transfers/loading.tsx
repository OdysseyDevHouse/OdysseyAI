import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Transfers screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false}>
      <StatStripSkeleton tiles={5} />
      <Card>
        <TableSkeleton columns={7} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
