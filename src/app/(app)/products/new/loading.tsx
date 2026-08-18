import { Card, FormSkeleton, PageSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the New product screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" back>
      <TabsSkeleton />
      <Card>
        <FormSkeleton fields={6} />
      </Card>
    </PageSkeleton>
  )
}
