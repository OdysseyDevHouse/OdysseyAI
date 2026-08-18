import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Job workflow screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false}>
      <Card>
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
