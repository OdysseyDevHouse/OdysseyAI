import { requireCapability } from '@/lib/auth'
import { openDraft, listItems, listRuns, nextPeriod } from '@/lib/site/depreciationRuns'
import { formatMoney } from '@/lib/decimals'
import { monthKey } from '@/lib/assetModel'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  EmptyState,
  Badge,
} from '@/components/ui'
import { DepreciationClient } from './DepreciationClient'

export const dynamic = 'force-dynamic'

/**
 * Charging depreciation.
 *
 * Propose, review, post — the same shape as an interest run or a payment run.
 * Depreciation is a real journal against the profit and loss, and an asset with
 * the wrong life quietly misstates profit every month until somebody notices,
 * so the workings are shown before anything is charged.
 */
export default async function DepreciationPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reports.financial')

  const [draft, runs, period] = await Promise.all([
    openDraft(siteId),
    listRuns(siteId, 24),
    nextPeriod(siteId),
  ])

  const items = draft ? await listItems(siteId, draft.id) : []

  return (
    <>
      <PageHeader title="Depreciation" subtitle="Charged monthly, straight line" />

      <PageBody>
        <DepreciationClient
          draft={
            draft
              ? {
                  id: draft.id,
                  periodMonth: draft.periodMonth,
                  totalAmount: draft.totalAmount,
                  assetCount: draft.assetCount,
                }
              : null
          }
          nextPeriod={period}
          items={items.map((i) => ({
            id: i.id,
            assetId: i.assetId,
            assetCode: i.assetCode,
            assetName: i.assetName,
            cost: i.cost,
            residualValue: i.residualValue,
            lifeMonths: i.lifeMonths,
            openingAccumulated: i.openingAccumulated,
            amount: i.amount,
            status: i.status,
            skipReason: i.skipReason,
            closingBookValue: i.closingBookValue,
          }))}
        />

        <Card>
          <CardHeader title="Previous runs" />
          {runs.filter((r) => r.status === 'posted').length === 0 ? (
            <CardBody>
              <EmptyState
                title="Nothing charged yet"
                hint="Depreciation turns an asset into a cost over the years it is used. Until it is charged, the profit and loss carries none of it."
              />
            </CardBody>
          ) : (
            <CardBody>
              <ul className="divide-y divide-border">
                {runs
                  .filter((r) => r.status === 'posted')
                  .map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2.5">
                      <div>
                        <span className="text-sm text-ink">{monthKey(r.periodMonth)}</span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {r.postedCount} asset{r.postedCount === 1 ? '' : 's'} · {r.userName}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        {r.batchId === null && (
                          // The register moved but the ledger did not — worth
                          // showing, because the balance sheet is then short.
                          <Badge tone="warning">No ledger entry</Badge>
                        )}
                        <span className="numeric text-sm text-ink">
                          {formatMoney(r.totalAmount)}
                        </span>
                      </div>
                    </li>
                  ))}
              </ul>
            </CardBody>
          )}
        </Card>

        <Card>
          <CardHeader title="How depreciation is charged here" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-medium text-ink">Straight line</dt>
                <dd className="text-muted">
                  Cost less residual value, spread evenly over the asset&apos;s useful life. What
                  the SARS wear-and-tear allowances assume, and what most small businesses use.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">It never goes below the residual</dt>
                <dd className="text-muted">
                  The last month charges whatever is left rather than the even amount, so an
                  asset lands exactly on its residual value instead of a few rand either side.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">A month cannot be charged twice</dt>
                <dd className="text-muted">
                  Each asset records the last month charged, and a month already posted cannot be
                  proposed again.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">One journal per run</dt>
                <dd className="text-muted">
                  Depreciation for a month is a single accounting event. The per-asset detail
                  lives on the run, which is where anyone looking for it would go.
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
