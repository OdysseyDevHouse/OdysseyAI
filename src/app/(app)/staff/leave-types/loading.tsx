import { Card, PageSkeleton, TableSkeleton } from '@/components/ui'

/** Holds the Leave types screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-44" action={false}>
      <Card>
        <TableSkeleton columns={5} rows={6} />
      </Card>
    </PageSkeleton>
  )
}
