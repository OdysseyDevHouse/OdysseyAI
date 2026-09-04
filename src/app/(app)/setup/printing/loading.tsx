import { Card, PageSkeleton, SettingRowsSkeleton, TableSkeleton } from '@/components/ui'

/**
 * Holds the Printing screen's shape while its data loads.
 *
 * Three setting cards then the assignment tables, at roughly the heights the
 * real thing renders at. A spinner would collapse the page and then shove it
 * back down — and this screen is tall enough that the shove lands wherever the
 * reader's eye already was.
 */
export default function Loading() {
  return (
    <PageSkeleton titleWidth="w-28" action={false}>
      <div className="flex flex-col gap-4">
        {/* Printers, the machine picker, and how it reaches them. */}
        <Card>
          <SettingRowsSkeleton rows={3} />
        </Card>
        <Card>
          <SettingRowsSkeleton rows={2} />
        </Card>
        <Card>
          <SettingRowsSkeleton rows={3} />
        </Card>
        {/* The assignment tables — the counter group and the sales group are
            the two that are always present, so two is the honest guess. */}
        <Card>
          <TableSkeleton rows={5} />
        </Card>
        <Card>
          <TableSkeleton rows={4} />
        </Card>
      </div>
    </PageSkeleton>
  )
}
