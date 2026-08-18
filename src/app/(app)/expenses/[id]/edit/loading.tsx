import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Edit draft expense screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false} back>
      <Card>
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
