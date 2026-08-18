import { Card, FormSkeleton, PageSkeleton } from '@/components/ui'

/** Holds the departments screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" back>
      <Card>
        <FormSkeleton fields={6} />
      </Card>
    </PageSkeleton>
  )
}
