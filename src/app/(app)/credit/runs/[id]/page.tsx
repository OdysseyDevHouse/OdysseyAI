import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getRun, listItems } from '@/lib/site/creditControl'
import { can } from '@/lib/site/permissions'
import { formatMoney } from '@/lib/decimals'
import { PageHeader, PageBody } from '@/components/ui'
import { RunReview, type ReviewItem } from './RunReview'

export const dynamic = 'force-dynamic'

/**
 * Reviewing a run before anything leaves the building.
 *
 * This screen is the entire reason runs are built and sent separately. A final
 * demand tells a customer their credit is suspended; forty of those sent by a
 * mis-set ladder is not something an apology fixes. So the proposal is shown in
 * full — including every account that will NOT be written to, and why — and a
 * person releases it.
 */
export default async function RunReviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { siteId, capabilities } = await requireModuleCapability('customers', 'customers.view')
  const { id } = await params

  const runId = Number(id)
  if (!Number.isFinite(runId) || runId <= 0) notFound()

  const run = await getRun(siteId, runId)
  if (!run) notFound()

  const items = await listItems(siteId, runId)

  // Plain serialisable rows — DataTable's columns are functions, so they live
  // in the client component and only data crosses the boundary.
  const rows: ReviewItem[] = items.map((i) => ({
    id: i.id,
    customerId: i.customerId,
    customerCode: i.customerCode,
    customerName: i.customerName,
    email: i.email,
    phone: i.phone,
    levelStep: i.levelStep,
    levelName: i.levelName,
    overdueAmount: i.overdueAmount,
    totalBalance: i.totalBalance,
    oldestDays: i.oldestDays,
    status: i.status,
    error: i.error,
    smsStatus: i.smsStatus,
    smsError: i.smsError,
    sentAtDate: i.sentAt ? i.sentAt.toISOString().slice(0, 10) : null,
  }))

  const queued = rows.filter((r) => r.status === 'queued')

  return (
    <>
      <PageHeader
        title={`Reminder run #${run.id}`}
        subtitle={
          run.status === 'draft'
            ? `${queued.length} to send · ${formatMoney(
                queued.reduce((sum, r) => sum + r.overdueAmount, 0),
              )} · nothing sent yet`
            : `Assessed as at ${run.asAt} · built by ${run.userName}`
        }
      />

      <PageBody>
        <RunReview
          run={{
            id: run.id,
            asAt: run.asAt,
            status: run.status,
            totalCount: run.totalCount,
            sentCount: run.sentCount,
            failedCount: run.failedCount,
            skippedCount: run.skippedCount,
            userName: run.userName,
            sentByName: run.sentByName,
          }}
          items={rows}
          canRelease={can(capabilities, 'customers.credit')}
        />
      </PageBody>
    </>
  )
}
