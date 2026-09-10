import { Card, FormSkeleton, PageSkeleton } from '@/components/ui'

/** Holds the shelves screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-64" action={false}>
      <Card>
        <FormSkeleton fields={5} />
      </Card>
    </PageSkeleton>
  )
}
