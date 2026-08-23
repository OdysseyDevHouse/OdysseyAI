import { Card, PageSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Reasons screen's shape while its three lists load. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-32" action={false}>
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={6} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
