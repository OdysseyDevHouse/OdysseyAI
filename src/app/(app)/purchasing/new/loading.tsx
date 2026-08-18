import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the New purchase order screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false} back>
      <Card>
        <TableSkeleton columns={3} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
