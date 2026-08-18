import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Budgets screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      <Card>
        <TableSkeleton columns={4} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
