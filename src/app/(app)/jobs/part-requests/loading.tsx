import { Card, FormSkeleton, PageSkeleton } from '@/components/ui'

/** Holds the Parts asked for screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <Card>
        <FormSkeleton fields={6} />
      </Card>
    </PageSkeleton>
  )
}
