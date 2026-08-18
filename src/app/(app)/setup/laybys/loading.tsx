import { Card, FormSkeleton, PageSkeleton } from '@/components/ui'

/** Holds the Lay-bys screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      <Card>
        <FormSkeleton fields={6} />
      </Card>
    </PageSkeleton>
  )
}
