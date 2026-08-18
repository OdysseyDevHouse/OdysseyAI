import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the return screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false} back>
      <Card>
        <TableSkeleton columns={4} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
