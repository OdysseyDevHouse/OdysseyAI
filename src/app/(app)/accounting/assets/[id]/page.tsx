import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { getAsset, assetSchedule } from '@/lib/site/fixedAssets'
import { listAccounts } from '@/lib/site/bankAccounts'
import { formatMoney } from '@/lib/decimals'
import { ASSET_STATUS_LABELS, ASSET_STATUS_HINTS, monthlyAmount } from '@/lib/assetModel'
import {
  PageHeader,
  PageBody,
  ButtonLink,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { DisposeButton } from './DisposeButton'

export const dynamic = 'force-dynamic'

/**
 * One asset: what it cost, what it is carried at, and what happens next.
 *
 * The schedule is the point. "When does this come off the books" and "what is
 * it costing us a month" are the two questions an owner has about an asset, and
 * both are answered by looking rather than calculating.
 */
export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reports.financial')
  const { id } = await params

  const assetId = Number(id)
  if (!Number.isFinite(assetId)) notFound()

  const asset = await getAsset(siteId, assetId)
  if (!asset) notFound()

  const [schedule, bankAccounts] = await Promise.all([
    assetSchedule(siteId, assetId),
    listAccounts(siteId),
  ])

  const monthly = monthlyAmount(asset.cost, asset.residualValue, asset.lifeMonths)
  const remaining = schedule.filter((r) => r.accumulated > asset.accumulatedDepreciation)

  return (
    <>
      <PageHeader
        title={asset.name}
        subtitle={`${asset.assetCode} · ${asset.categoryName}${asset.serialNumber ? ` · ${asset.serialNumber}` : ''}`}
        action={
          asset.status !== 'disposed' ? (
            <div className="flex items-center gap-2">
              <ButtonLink href={`/accounting/assets/${asset.id}/edit`} variant="secondary">
                <Icons.Pencil size={15} />
                Edit
              </ButtonLink>
              <DisposeButton
                id={asset.id}
                assetName={asset.name}
                bookValue={asset.bookValue}
                bankAccounts={bankAccounts.map((a) => ({ id: a.id, name: a.name }))}
              />
            </div>
          ) : undefined
        }
      />

      <PageBody>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            tone={
              asset.status === 'disposed'
                ? 'default'
                : asset.status === 'pending'
                  ? 'warning'
                  : 'success'
            }
          >
            {ASSET_STATUS_LABELS[asset.status]}
          </Badge>
          {asset.fullyDepreciated && asset.status !== 'disposed' && (
            <Badge tone="default">Fully depreciated</Badge>
          )}
          {asset.location && <Badge tone="default">{asset.location}</Badge>}
        </div>

        {asset.status === 'pending' && (
          <Card>
            <CardBody>
              <p className="text-sm text-muted">{ASSET_STATUS_HINTS.pending}</p>
            </CardBody>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Cost" value={formatMoney(asset.cost)} hint={asset.acquiredOn} />
          <StatTile
            label="Depreciated"
            value={formatMoney(asset.accumulatedDepreciation)}
            hint={asset.lastDepreciatedTo ? `To ${asset.lastDepreciatedTo.slice(0, 7)}` : 'Not yet started'}
          />
          <StatTile
            label="Book value"
            value={formatMoney(asset.bookValue)}
            hint="What the balance sheet carries"
          />
          <StatTile
            label={asset.status === 'disposed' ? 'Disposed for' : 'Per month'}
            value={formatMoney(
              asset.status === 'disposed' ? (asset.disposalProceeds ?? 0) : monthly,
            )}
            hint={
              asset.status === 'disposed'
                ? asset.disposedOn ?? undefined
                : `${remaining.length} month${remaining.length === 1 ? '' : 's'} left`
            }
          />
        </div>

        {asset.status === 'disposed' && (
          <Card>
            <CardHeader
              title="Disposal"
              description={asset.disposalReason ?? undefined}
            />
            <CardBody>
              <dl className="space-y-2 text-sm">
                <Row label="Disposed on" value={asset.disposedOn ?? '—'} />
                <Row label="Proceeds" value={formatMoney(asset.disposalProceeds ?? 0)} />
                <div className="flex justify-between">
                  <dt className="text-muted">
                    {(asset.disposalResult ?? 0) >= 0 ? 'Profit on sale' : 'Loss on sale'}
                  </dt>
                  <dd
                    className={`numeric ${(asset.disposalResult ?? 0) >= 0 ? 'text-success' : 'text-danger'}`}
                  >
                    {formatMoney(Math.abs(asset.disposalResult ?? 0))}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>
        )}

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="space-y-2 text-sm">
                <Row label="Category" value={asset.categoryName ?? '—'} />
                <Row label="Acquired" value={asset.acquiredOn} />
                <Row label="Depreciation starts" value={asset.depreciationStart} />
                <Row label="Useful life" value={`${asset.lifeMonths} months`} />
                <Row label="Residual value" value={formatMoney(asset.residualValue)} />
                {asset.serialNumber && <Row label="Serial" value={asset.serialNumber} />}
                {asset.invoiceNumber && <Row label="Invoice" value={asset.invoiceNumber} />}
                {asset.supplierName && <Row label="Supplier" value={asset.supplierName} />}
                {asset.expenseId && (
                  <div className="flex justify-between">
                    <dt className="text-muted">Bought on</dt>
                    <dd>
                      <Link
                        href={`/expenses/${asset.expenseId}`}
                        className="text-brand hover:underline"
                      >
                        the expense that paid for it
                      </Link>
                    </dd>
                  </div>
                )}
                <Row label="Added by" value={asset.userName} />
              </dl>
              {asset.notes && (
                <p className="mt-4 rounded-control bg-surface-2 px-3 py-2 text-sm text-ink-2">
                  {asset.notes}
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Depreciation schedule"
              description={
                asset.status === 'disposed'
                  ? 'What it would have been, had it not been disposed of.'
                  : 'Month by month, to the end of its life.'
              }
            />
            <div className="max-h-96 overflow-y-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Month</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Charge</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Book value</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((row) => {
                    // Everything up to what has actually been charged is
                    // history; the rest is the plan.
                    const isPast = row.accumulated <= asset.accumulatedDepreciation
                    return (
                      <tr key={row.month} className={TABLE_ROW}>
                        <td className={TABLE_TD}>
                          <span className={isPast ? 'text-muted' : 'text-ink'}>{row.month}</span>
                          {isPast && <span className="ml-2 text-xs text-muted">charged</span>}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          <span className={isPast ? 'text-muted' : ''}>
                            {formatMoney(row.amount)}
                          </span>
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                          {formatMoney(row.bookValue)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="text-ink-2">{value}</dd>
    </div>
  )
}
