import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Customer groups screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <Card>
        <TableSkeleton columns={8} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
