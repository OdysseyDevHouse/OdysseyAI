import { notFound } from 'next/navigation'
import { PrintDocumentButton } from '@/components/PrintDocumentButton'
import { requireCapability } from '@/lib/auth'
import { getSchedule, staleLines } from '@/lib/site/priceSchedules'
import { listPriceStructures } from '@/lib/site/lookups'
import { listDepartments } from '@/lib/site/departments'
import { PageHeader, PageBody } from '@/components/ui'
import ScheduleEditor from './ScheduleEditor'

/**
 * One price change: what it does, and when.
 *
 * `staleLines` is resolved here rather than in the client so the warning is
 * true at the moment the page renders. A change built on Monday and opened on
 * Friday may have been overtaken by somebody editing a price by hand, and
 * applying it would silently undo that edit.
 */

export const dynamic = 'force-dynamic'

export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const { siteId } = await requireCapability('products.edit')
  const { id } = await params
  const scheduleId = Number(id)
  if (!Number.isFinite(scheduleId)) notFound()

  const schedule = await getSchedule(siteId, scheduleId)
  if (!schedule) notFound()

  const [structures, departments, stale] = await Promise.all([
    listPriceStructures(siteId),
    listDepartments(siteId),
    staleLines(siteId, scheduleId),
  ])

  return (
    <>
      <PageHeader
        title={schedule.name}
        subtitle="New prices that take effect on their own, at a date and time you choose"
        action={
          /* Labels for THIS change — printed at five, showing the six o'clock
             price, because labelItems reads the schedule's own lines. */
          schedule.status === 'armed' || schedule.status === 'applied' ? (
            <PrintDocumentButton
              href={`/labels/a4?source=schedule&id=${schedule.id}`}
              label="Print labels"
            />
          ) : undefined
        }
      />
      <PageBody>
        <ScheduleEditor
          schedule={schedule}
          structures={structures.map((s) => ({ id: s.id, name: s.name }))}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          staleCount={stale.length}
        />
      </PageBody>
    </>
  )
}
