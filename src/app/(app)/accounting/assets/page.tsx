import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import {
  listAssets,
  listCategories,
  assetSummary,
  unregisteredCapitalExpenses,
} from '@/lib/site/fixedAssets'
import { openDraft, nextPeriod } from '@/lib/site/depreciationRuns'
import { formatMoney } from '@/lib/decimals'
import { monthKey } from '@/lib/assetModel'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  ButtonLink,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  EmptyState,
  Icons,
  TableToolbar,
  LinkSegmentedControl,
} from '@/components/ui'
import { AssetsTable, type AssetTableRow } from './AssetsTable'

export const dynamic = 'force-dynamic'

/**
 * The fixed asset register — what the business owns.
 *
 * The screen leads with the two things needing action rather than the total:
 * a depreciation month not yet charged (which is missing from the profit and
 * loss until somebody runs it) and capital spending that never became an asset
 * (which is sitting on the balance sheet with nothing depreciating it).
 */

type AssetRow = Awaited<ReturnType<typeof listAssets>>[number]

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; category?: string; q?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reports.financial')
  const params = await searchParams

  const status =
    params.status === 'pending' || params.status === 'disposed' || params.status === 'active'
      ? params.status
      : undefined

  const [assets, categories, summary, draft, period, unregistered] = await Promise.all([
    listAssets(siteId, {
      status,
      categoryId: Number(params.category) || undefined,
      search: params.q,
    }),
    listCategories(siteId),
    assetSummary(siteId),
    openDraft(siteId),
    nextPeriod(siteId),
    unregisteredCapitalExpenses(siteId, 10),
  ])

  const href = hrefBuilder('/accounting/assets', params)

  // Plain rows; the table that draws them owns its columns. See AssetsTable.
  const assetRows: AssetTableRow[] = assets.map((a) => ({
    id: a.id,
    assetCode: a.assetCode,
    name: a.name,
    serialNumber: a.serialNumber,
    location: a.location,
    categoryName: a.categoryName ?? null,
    status: a.status,
    fullyDepreciated: a.fullyDepreciated,
    cost: a.cost,
    accumulatedDepreciation: a.accumulatedDepreciation,
    bookValue: a.bookValue,
  }))

  return (
    <>
      <PageHeader
        title="Fixed assets"
        subtitle={`${summary.count} owned · ${formatMoney(summary.totalBookValue)} book value`}
        action={
          <div className="flex items-center gap-2">
            <ButtonLink href="/accounting/assets/depreciation" variant="secondary">
              <Icons.Clock size={15} />
              Depreciation
            </ButtonLink>
            <ButtonLink href="/accounting/assets/new">
              <Icons.Plus size={15} />
              Add asset
            </ButtonLink>
          </div>
        }
      />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="At cost" value={formatMoney(summary.totalCost)} />
          <StatTile
            label="Depreciated"
            value={formatMoney(summary.totalAccumulated)}
            hint="Written off to date"
          />
          <StatTile
            label="Book value"
            value={formatMoney(summary.totalBookValue)}
            hint="What the balance sheet carries"
          />
          <StatTile
            label="Not yet in use"
            value={String(summary.pendingCount)}
            tone={summary.pendingCount > 0 ? 'warning' : 'default'}
            hint={
              summary.pendingCount > 0
                ? 'Owned but not depreciating'
                : 'Everything is in use'
            }
          />
        </div>

        {/* A month not yet charged is missing from the profit and loss, and
            nothing else on this screen will produce it. */}
        <Card>
          <CardHeader
            title={
              draft
                ? `A depreciation run for ${monthKey(draft.periodMonth)} is waiting`
                : `${monthKey(period)} has not been depreciated yet`
            }
            description={
              draft
                ? 'It has been worked out but not posted — review and charge it.'
                : 'Until it is charged, that month understates costs and overstates profit.'
            }
            action={
              <ButtonLink href="/accounting/assets/depreciation" size="sm">
                {draft ? 'Review it' : 'Work it out'}
              </ButtonLink>
            }
          />
        </Card>

        {/* Capital spending that never became an asset: the cost is on the
            balance sheet with nothing depreciating it. */}
        {unregistered.length > 0 && (
          <Card>
            <CardHeader
              title={`${unregistered.length} capital purchase${unregistered.length === 1 ? '' : 's'} not on the register`}
              description="These were captured as capital, so they are on the balance sheet — but nothing is depreciating them until they are recorded as assets."
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {unregistered.map((e) => (
                  <li key={e.expenseId} className="flex items-center justify-between py-2">
                    <div>
                      <Link
                        href={`/expenses/${e.expenseId}`}
                        className="text-sm text-ink hover:text-brand"
                      >
                        {e.documentNumber ?? `Expense #${e.expenseId}`}
                      </Link>
                      <span className="ml-2 text-xs text-muted">
                        {e.expenseDate}
                        {e.supplierName ? ` · ${e.supplierName}` : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="numeric text-sm text-ink">{formatMoney(e.total)}</span>
                      <ButtonLink
                        href={`/accounting/assets/new?expense=${e.expenseId}`}
                        variant="secondary"
                        size="sm"
                      >
                        Record it
                      </ButtonLink>
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Register" description="Everything the business owns and uses." />

          <TableToolbar className="border-b border-border px-6 py-3">
            <LinkSegmentedControl
              aria-label="Asset status"
              value={status ?? 'all'}
              options={[
                { value: 'all', label: 'In use', href: href({ status: null }) },
                {
                  value: 'pending',
                  label: 'Not yet in use',
                  href: href({ status: 'pending' }),
                  count: summary.pendingCount > 0 ? summary.pendingCount : undefined,
                },
                { value: 'disposed', label: 'Disposed', href: href({ status: 'disposed' }) },
              ]}
            />
          </TableToolbar>

          {assets.length === 0 ? (
            <CardBody>
              <EmptyState
                title={params.q ? `Nothing matches "${params.q}"` : 'No assets recorded'}
                hint={
                  params.q
                    ? 'Try a different search.'
                    : 'Vehicles, equipment, computers, shopfitting — anything the business owns and uses rather than sells.'
                }
                action={
                  !params.q ? (
                    <ButtonLink href="/accounting/assets/new">
                      <Icons.Plus size={15} />
                      Add the first one
                    </ButtonLink>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <AssetsTable rows={assetRows} />
          )}
        </Card>

        {categories.length > 0 && (
          <Card>
            <CardHeader title="By category" description="What each kind of asset is carried at." />
            <CardBody>
              <ul className="divide-y divide-border">
                {categories.map((c) => (
                  <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <span className="text-ink">{c.name}</span>
                      <span className="ml-2 text-xs text-muted">
                        {c.defaultLifeMonths} months
                        {c.defaultResidualPct > 0 ? ` · ${c.defaultResidualPct}% residual` : ''}
                        {' · '}
                        {c.assetCount} asset{c.assetCount === 1 ? '' : 's'}
                      </span>
                    </div>
                    <span className="numeric text-ink-2">{formatMoney(c.bookValue ?? 0)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </PageBody>
    </>
  )
}
