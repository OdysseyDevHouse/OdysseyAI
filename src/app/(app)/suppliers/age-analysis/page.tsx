import { requireCapability } from '@/lib/auth'
import { supplierAging, type AgingBasis } from '@/lib/site/aging'
import { formatMoney } from '@/lib/decimals'
import { BUCKET_LABELS, today } from '@/lib/site/ledger'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Card,
  StatStrip,
  StatTile,
  FilterBar,
  FilterChip,
  LinkSegmentedControl,
  TableToolbar,
  Icons,
} from '@/components/ui'
import { AgeingStrip } from '@/components/ledger/AgeingStrip'
import AgeAnalysisTable from './AgeAnalysisTable'

export const dynamic = 'force-dynamic'

/**
 * The payables age analysis — who we owe, and how late we are.
 *
 * The debtors mirror, with one difference in emphasis: overdue here is OUR
 * problem, not the counterparty's, so the tone reads as a warning about our own
 * position rather than a collections list.
 *
 * DataTable rather than the hand-built matrix: sorting a bucket column is how
 * "who is deepest in 90 days" gets answered, and the per-bucket totals already
 * live in the AgeingStrip above the table.
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
        icon={<Icons.Scale size={18} />}
        subtitle={
          isHistoric
            ? `${rows.length} supplier${rows.length === 1 ? '' : 's'} as at ${asAt}`
            : `${rows.length} supplier${rows.length === 1 ? '' : 's'} with a balance`
        }
      />

      <PageBody>
        <StatStrip>
          <StatTile
            label="Total owed"
            value={formatMoney(totals.total)}
            iconTone="success"
            icon={<Icons.Coins size={20} />}
          />
          <StatTile
            label="Not yet due"
            value={formatMoney(totals.current)}
            hint="Within terms"
            icon={<Icons.Clock size={20} />}
          />
          <StatTile
            label="Overdue"
            value={formatMoney(overdue)}
            tone={overdue > 0 ? 'warning' : 'default'}
            hint={overdue > 0 ? 'We are late paying' : 'All within terms'}
            icon={<Icons.StatusWarning size={20} />}
          />
          <StatTile
            label="90 days and older"
            value={formatMoney(totals.d90 + totals.d120)}
            tone={totals.d90 + totals.d120 > 0 ? 'danger' : 'default'}
            hint="Supply at risk"
            icon={<Icons.Ban size={20} />}
          />
        </StatStrip>

        {/* Per-bucket totals live here — the table below does not repeat them. */}
        <AgeingStrip aging={totals} />

        {isHistoric && (
          <div className="-mx-6 -my-3">
            <FilterBar clearHref="/suppliers/age-analysis">
              <FilterChip label="As at" value={asAt} clearHref={href({ asAt: null })} />
            </FilterBar>
          </div>
        )}

        <Card>
          <TableToolbar inCard>
            <LinkSegmentedControl
              aria-label="Which suppliers to show"
              value={overdueOnly ? 'overdue' : 'all'}
              options={[
                {
                  value: 'all',
                  label: 'All',
                  icon: <Icons.LayoutGrid size={15} />,
                  href: href({ overdue: null }),
                },
                {
                  value: 'overdue',
                  label: 'Overdue only',
                  icon: <Icons.StatusWarning size={15} />,
                  href: href({ overdue: '1' }),
                },
              ]}
            />
            {/* This bar is a MODE switch, not a status filter — it changes how
                the same balances are aged. So the glyphs name the two dates
                being chosen between, rather than borrowing the tick/cross pair
                that everywhere else in the app means "state". */}
            <LinkSegmentedControl
              aria-label="How to age the balances"
              value={basis}
              options={[
                {
                  value: 'due',
                  label: 'By due date',
                  icon: <Icons.CalendarClock size={15} />,
                  href: href({ basis: null }),
                },
                {
                  value: 'doc',
                  label: 'By document date',
                  icon: <Icons.FileText size={15} />,
                  href: href({ basis: 'doc' }),
                },
              ]}
            />
          </TableToolbar>

          {/* Rows are plain data; the columns' functions live in the client
              component, where they are allowed to. */}
          <AgeAnalysisTable
            rows={rows}
            bucketLabels={BUCKET_LABELS}
            overdueOnly={overdueOnly}
            showAllHref={href({ overdue: null })}
          />
        </Card>
      </PageBody>
    </>
  )
}
