import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Depreciation screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false}>
      <Card>
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
