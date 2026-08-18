import { Card, FormSkeleton, PageSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Loyalty screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      <TabsSkeleton />
      <Card>
        <FormSkeleton fields={6} />
      </Card>
    </PageSkeleton>
  )
}
