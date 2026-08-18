import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Opening balances screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <StatStripSkeleton tiles={3} hint />
      <Card>
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
