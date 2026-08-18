import { Card, PageSkeleton, SettingRowsSkeleton, Skeleton } from '@/components/ui'

/** Holds the purchasing settings screen's shape while the current values load. */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-52" action={false}>
      <Card>
        <SettingRowsSkeleton rows={3} />
        {/* The footer's Save button — outside the rows, as on the real screen. */}
        <div aria-hidden className="flex justify-end border-t border-border px-6 py-4">
          <Skeleton className="h-control w-28" />
        </div>
      </Card>
    </PageSkeleton>
  )
}
