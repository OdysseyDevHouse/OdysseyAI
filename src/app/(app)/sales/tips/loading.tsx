import { Card, FormSkeleton, PageSkeleton, StatStripSkeleton } from '@/components/ui'

/** Holds the Tips screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      <StatStripSkeleton tiles={2} />
      <Card>
        <FormSkeleton fields={6} />
      </Card>
    </PageSkeleton>
  )
}
