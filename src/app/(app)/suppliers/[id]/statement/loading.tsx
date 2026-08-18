import { PageSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Supplier account screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" back>
      <TabsSkeleton />
    </PageSkeleton>
  )
}
