import { Card, PageSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the API & webhooks screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false}>
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
