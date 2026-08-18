import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Adjustment reasons screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <Card>
        <TableSkeleton columns={5} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
