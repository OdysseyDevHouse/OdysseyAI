import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Return without a receipt screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-64" action={false} back>
      <Card>
        <TableSkeleton columns={5} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
