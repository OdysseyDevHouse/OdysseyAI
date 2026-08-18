import { Card, FormSkeleton, PageSkeleton } from '@/components/ui'

/** Holds the My work screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28">
      <Card>
        <FormSkeleton fields={6} />
      </Card>
    </PageSkeleton>
  )
}
