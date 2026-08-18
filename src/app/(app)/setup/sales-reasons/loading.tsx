import { Card, PageSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Void & return reasons screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-64" action={false}>
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
