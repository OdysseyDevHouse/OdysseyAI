import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { supplierAging, type AgingBasis } from '@/lib/site/aging'
import { formatMoney } from '@/lib/decimals'
import { BUCKET_LABELS, today } from '@/lib/site/ledger'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  Card,
  StatTile,
  FilterBar,
  FilterChip,
  EmptyState,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { AgeingStrip } from '@/components/ledger/AgeingStrip'

export const dynamic = 'force-dynamic'

/**
 * The payables age analysis — who we owe, and how late we are.
 *
 * The debtors mirror, with one difference in emphasis: overdue here is OUR
 * problem, not the counterparty's, so the tone reads as a warning about our own
 * position rather than a collections list.
 */
export default async function SupplierAgeAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ asAt?: string; basis?: string; overdue?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('suppliers.view')
  const params = await searchParams

  const asAt = /^\d{4}-\d{2}-\d{2}$/.test(params.asAt ?? '') ? params.asAt! : today()
  const basis: AgingBasis = params.basis === 'doc' ? 'doc' : 'due'
  const overdueOnly = params.overdue === '1'

  const { rows, totals } = await supplierAging(siteId, { asAt, basis, overdueOnly })

  const href = hrefBuilder('/suppliers/age-analysis', params)
  const isHistoric = asAt < today()
  const overdue = totals.d30 + totals.d60 + totals.d90 + totals.d120

  return (
    <>
      <PageHeader
        title="Payables age analysis"
        subtitle={
          isHistoric
            ? `${rows.length} supplier${rows.length === 1 ? '' : 's'} as at ${asAt}`
            : `${rows.length} supplier${rows.length === 1 ? '' : 's'} with a balance`
        }
      />

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 lg:grid-cols-4">
        <StatTile
          label="Total owed"
          value={formatMoney(totals.total)}
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="Not yet due"
          value={formatMoney(totals.current)}
          hint="Within terms"
          icon={<Icons.Clock size={16} />}
        />
        <StatTile
          label="Overdue"
          value={formatMoney(overdue)}
          tone={overdue > 0 ? 'warning' : 'default'}
          hint={overdue > 0 ? 'We are late paying' : 'All within terms'}
          icon={<Icons.StatusWarning size={16} />}
        />
        <StatTile
          label="90 days and older"
          value={formatMoney(totals.d90 + totals.d120)}
          tone={totals.d90 + totals.d120 > 0 ? 'danger' : 'default'}
          hint="Supply at risk"
          icon={<Icons.Ban size={16} />}
        />
      </div>

      <div className="px-6 pt-4">
        <AgeingStrip aging={totals} />
      </div>

      <FilterBar clearHref="/suppliers/age-analysis">
        {isHistoric && <FilterChip label="As at" value={asAt} clearHref={href({ asAt: null })} />}
        {basis === 'doc' && (
          <FilterChip label="Aged by" value="Document date" clearHref={href({ basis: null })} />
        )}
        {overdueOnly && (
          <FilterChip label="Showing" value="Overdue only" clearHref={href({ overdue: null })} />
        )}
      </FilterBar>

      <div className="flex gap-3 px-6 pb-3 text-xs">
        <Link
          href="/suppliers/age-analysis"
          className={!overdueOnly ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
        >
          All
        </Link>
        <Link
          href={href({ overdue: overdueOnly ? null : '1' })}
          className={overdueOnly ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
        >
          Overdue only
        </Link>
        <Link
          href={href({ basis: basis === 'doc' ? null : 'doc' })}
          className={basis === 'doc' ? 'font-medium text-brand' : 'text-muted hover:text-ink'}
        >
          Age by document date
        </Link>
      </div>

      <div className="px-6 pb-10">
        <Card>
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing owed"
              hint={
                overdueOnly
                  ? 'Nothing is past its due date.'
                  : 'No supplier has an outstanding balance.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Supplier</th>
                    <th className={TABLE_TH}>Our account</th>
                    <th className={`${TABLE_TH} text-right`}>{BUCKET_LABELS.current}</th>
                    <th className={`${TABLE_TH} text-right`}>{BUCKET_LABELS.d30}</th>
                    <th className={`${TABLE_TH} text-right`}>{BUCKET_LABELS.d60}</th>
                    <th className={`${TABLE_TH} text-right`}>{BUCKET_LABELS.d90}</th>
                    <th className={`${TABLE_TH} text-right`}>{BUCKET_LABELS.d120}</th>
                    <th className={`${TABLE_TH} text-right`}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <Link
                          href={`/suppliers/${row.id}?tab=transactions`}
                          className="text-brand hover:underline"
                        >
                          {row.code}
                        </Link>
                        <div className="text-ink">{row.name}</div>
                        {row.status !== 'active' && (
                          <span className="mt-1 inline-block">
                            <Badge tone={row.status === 'on_hold' ? 'danger' : 'neutral'}>
                              {row.status === 'on_hold' ? 'On hold' : row.status}
                            </Badge>
                          </span>
                        )}
                      </td>
                      <td className={TABLE_TD}>
                        <div className="text-ink-2">{row.accountNumber ?? '—'}</div>
                        {row.contactName && (
                          <div className="text-xs text-muted">{row.contactName}</div>
                        )}
                      </td>
                      <Bucket value={row.aging.current} />
                      <Bucket value={row.aging.d30} />
                      <Bucket value={row.aging.d60} tone="warning" />
                      <Bucket value={row.aging.d90} tone="danger" />
                      <Bucket value={row.aging.d120} tone="danger" />
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium text-ink`}>
                        {formatMoney(row.aging.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-surface-2">
                    <td className={`${TABLE_TD} font-semibold text-ink`} colSpan={2}>
                      {rows.length} supplier{rows.length === 1 ? '' : 's'}
                    </td>
                    {(['current', 'd30', 'd60', 'd90', 'd120'] as const).map((bucket) => (
                      <td
                        key={bucket}
                        className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold text-ink`}
                      >
                        {formatMoney(totals[bucket])}
                      </td>
                    ))}
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold text-ink`}>
                      {formatMoney(totals.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

function Bucket({ value, tone }: { value: number; tone?: 'warning' | 'danger' }) {
  const colour =
    value === 0
      ? 'text-faint'
      : tone === 'danger'
        ? 'text-danger'
        : tone === 'warning'
          ? 'text-warning'
          : 'text-ink-2'
  return <td className={`${TABLE_TD} ${TABLE_NUMERIC} ${colour}`}>{formatMoney(value)}</td>
}
