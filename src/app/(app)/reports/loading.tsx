import { PageSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Reports screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      <TabsSkeleton />
    </PageSkeleton>
  )
}
