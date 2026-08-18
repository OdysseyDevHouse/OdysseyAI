import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Clock in and out screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <Card>
        <TableSkeleton columns={4} rows={10} />
      </Card>
    </PageSkeleton>
  )
}
