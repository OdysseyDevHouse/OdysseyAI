import { Card, PageSkeleton, StatStripSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Recurring work screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false}>
      <StatStripSkeleton tiles={3} />
      <Card>
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
