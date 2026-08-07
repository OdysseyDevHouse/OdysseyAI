import { requireCapability } from '@/lib/auth'
import { listRuns, listItems } from '@/lib/site/interestRuns'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
} from '@/components/ui'
import { InterestClient } from './InterestClient'
import { RunsTable, type RunRow } from './RunsTable'

export const dynamic = 'force-dynamic'

/**
 * Charging interest on overdue accounts.
 *
 * Propose, review, post — the payment-run shape, for a stronger reason.
 * Interest is the charge most likely to be disputed and least likely to be
 * noticed before it goes out, so a draft showing exactly who will be charged
 * what, on what base, for how many days is the whole point of the screen.
 */
export default async function InterestPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('customers.credit')

  const runs = await listRuns(siteId, 10)
  const draft = runs.find((r) => r.status === 'draft')
  const draftItems = draft ? await listItems(siteId, draft.id) : []
  // Plain serializable rows — DataTable's columns are functions, so they live
  // in the client component and only data crosses the boundary.
  const previousRuns: RunRow[] = runs
    .filter((r) => r.status !== 'draft')
    .map((r) => ({
      id: r.id,
      periodFrom: r.periodFrom,
      periodTo: r.periodTo,
      asAtDate: r.asAtDate,
      userName: r.userName,
      status: r.status,
      postedAtDate: r.postedAt ? r.postedAt.toISOString().slice(0, 10) : null,
      postedCount: r.postedCount,
      totalAmount: r.totalAmount,
    }))

  return (
    <>
      <PageHeader
        title="Interest"
        subtitle="Charge interest on overdue accounts"
      />

      <PageBody>
        <InterestClient
          draft={
            draft
              ? {
                  id: draft.id,
                  asAtDate: draft.asAtDate,
                  periodFrom: draft.periodFrom,
                  periodTo: draft.periodTo,
                  totalAmount: draft.totalAmount,
                  accountCount: draft.accountCount,
                  minimumCharge: draft.minimumCharge,
                }
              : null
          }
          items={draftItems.map((i) => ({
            id: i.id,
            customerId: i.customerId,
            customerCode: i.customerCode,
            customerName: i.customerName,
            baseAmount: i.baseAmount,
            ratePct: i.ratePct,
            days: i.days,
            amount: i.amount,
            status: i.status,
            skipReason: i.skipReason,
          }))}
        />

        <Card>
          <CardHeader title="Previous runs" />
          <RunsTable rows={previousRuns} />
        </Card>

        <Card>
          <CardHeader title="How interest is calculated" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-medium text-ink">Off unless switched on</dt>
                <dd className="text-muted">
                  Every account starts with interest disabled. The National Credit Act requires
                  the charge to be agreed in writing, so a site that never configures this never
                  charges anything.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Per invoice, not per balance</dt>
                <dd className="text-muted">
                  An account with one invoice 90 days late and one issued yesterday is charged 90
                  days on the first and nothing on the second.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Simple, never compound</dt>
                <dd className="text-muted">
                  Interest already charged does not itself attract interest — that needs an
                  agreement this system cannot verify.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">In duplum</dt>
                <dd className="text-muted">
                  Unpaid interest may never exceed the capital outstanding. Section 103(5) of the
                  Act, applied automatically on every run.
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
