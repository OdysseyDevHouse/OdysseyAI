import { PageSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Tickets screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28">
      <TabsSkeleton />
    </PageSkeleton>
  )
}
