import { PageSkeleton, StatStripSkeleton } from '@/components/ui'

/** Holds the Schedule screen's shape while its data loads. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28">
      <StatStripSkeleton tiles={3} />
    </PageSkeleton>
  )
}
