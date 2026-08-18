import { PageSkeleton, StatStripSkeleton, TabsSkeleton } from '@/components/ui'

/** Holds the Sales by store screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-40" action={false}>
      <StatStripSkeleton tiles={3} hint />
      <TabsSkeleton />
    </PageSkeleton>
  )
}
