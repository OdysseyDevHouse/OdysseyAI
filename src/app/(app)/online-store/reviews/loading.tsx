import { Card, FormSkeleton, PageSkeleton, StatStripSkeleton } from '@/components/ui'

/** Holds the Reviews screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28">
      <StatStripSkeleton tiles={3} hint />
      <Card>
        <FormSkeleton fields={6} />
      </Card>
    </PageSkeleton>
  )
}
