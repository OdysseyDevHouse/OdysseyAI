import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Multi-store overview screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <StatStripSkeleton tiles={5} hint />
      <Card>
        <TableSkeleton columns={7} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
