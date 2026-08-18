import { Card, PageSkeleton, TableSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Price types & VAT screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <TabsSkeleton />
      <Card>
        <TableSkeleton columns={4} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
