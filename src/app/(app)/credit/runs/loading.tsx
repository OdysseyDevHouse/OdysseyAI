import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Reminder runs screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40">
      <Card>
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
