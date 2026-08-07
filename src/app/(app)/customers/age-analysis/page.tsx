import { requireCapability } from '@/lib/auth'
import { customerAging, type AgingBasis } from '@/lib/site/aging'
import { listCustomerGroups, listSalesReps } from '@/lib/site/customerLookups'
import { formatMoney } from '@/lib/decimals'
import { BUCKET_LABELS, today } from '@/lib/site/ledger'
import { hrefBuilder, withParams } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  StatTile,
  StatStrip,
  FilterBar,
  FilterChip,
  EmptyState,
  Badge,
  Icons,
  Menu,
  MenuItem,
  TextLink,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
  TABLE_TOTAL_ROW,
} from '@/components/ui'
import AsAtForm from './AsAtForm'

export const dynamic = 'force-dynamic'

/* Copied from the customers list page (page modules cannot export extras). */
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  on_hold: 'On hold',
  inactive: 'Inactive',
  closed: 'Closed',
}

type Search = {
  asAt?: string
  basis?: string
  overdue?: string
  group?: string
  rep?: string
}

/**
 * The debtors age analysis.
 *
 * A hand-built table rather than DataTable: this is a matrix with a totals row
 * and per-cell tone, which DataTable's column model cannot express. It wears
 * the shared table skin so it still sits identically beside every other list.
 */
export default async function AgeAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('customers.view')
  const params = await searchParams

  const asAt = /^\d{4}-\d{2}-\d{2}$/.test(params.asAt ?? '') ? params.asAt! : today()
  const basis: AgingBasis = params.basis === 'doc' ? 'doc' : 'due'
  const overdueOnly = params.overdue === '1'
  const groupId = Number(params.group) || undefined
  const repId = Number(params.rep) || undefined

  const [{ rows, totals }, groups, reps] = await Promise.all([
    customerAging(siteId, { asAt, basis, overdueOnly, groupId, repId }),
    listCustomerGroups(siteId),
    listSalesReps(siteId),
  ])

  const href = hrefBuilder('/customers/age-analysis', params)
  const isHistoric = asAt < today()
  const groupName = groups.find((g) => g.id === groupId)?.name
  const repName = reps.find((r) => r.id === repId)?.name

  const exportHref = (format: 'xlsx' | 'csv') =>
    `/api/customers/age-analysis/export${withParams(params, { format })}`

  return (
    <>
      <PageHeader
        title="Age analysis"
        subtitle={
          isHistoric
            ? `${rows.length} account${rows.length === 1 ? '' : 's'} as at ${asAt}`
            : `${rows.length} account${rows.length === 1 ? '' : 's'} with a balance`
        }
        action={
          <div className="flex items-center gap-2">
            <Menu label="Export" variant="secondary">
              <MenuItem href={exportHref('xlsx')} download>
                <Icons.Spreadsheet size={15} />
                Excel (.xlsx)
              </MenuItem>
              <MenuItem href={exportHref('csv')} download>
                <Icons.FileText size={15} />
                CSV
              </MenuItem>
            </Menu>
            {/* The next step after reading this screen: chase the money. */}
            <PrimaryLink href="/customers/statements">
              <Icons.Send size={15} />
              Send statements
            </PrimaryLink>
          </div>
        }
      />

      <PageBody>
        {/* The tiles ARE the bucket summary — an AgeingStrip here would say
            the same numbers twice. */}
        <StatStrip columns={4}>
          <StatTile
            label="Total outstanding"
            value={formatMoney(totals.total)}
            hint="The whole book"
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
            value={formatMoney(totals.d30 + totals.d60 + totals.d90 + totals.d120)}
            tone={totals.d30 + totals.d60 + totals.d90 + totals.d120 > 0 ? 'warning' : 'default'}
            hint="Past due date"
            icon={<Icons.StatusWarning size={16} />}
          />
          <StatTile
            label="90 days and older"
            value={formatMoney(totals.d90 + totals.d120)}
            tone={totals.d90 + totals.d120 > 0 ? 'danger' : 'default'}
            hint="At risk"
            icon={<Icons.Ban size={16} />}
          />
        </StatStrip>

        <AsAtForm asAt={asAt} basis={basis} overdueOnly={overdueOnly} />

        <FilterBar clearHref="/customers/age-analysis" className="-mx-6 -my-2">
        {isHistoric && <FilterChip label="As at" value={asAt} clearHref={href({ asAt: null })} />}
        {basis === 'doc' && (
          <FilterChip label="Aged by" value="Document date" clearHref={href({ basis: null })} />
        )}
        {overdueOnly && (
          <FilterChip label="Showing" value="Overdue only" clearHref={href({ overdue: null })} />
        )}
        {groupName && (
          <FilterChip label="Group" value={groupName} clearHref={href({ group: null })} />
        )}
        {repName && <FilterChip label="Rep" value={repName} clearHref={href({ rep: null })} />}
        </FilterBar>

        <Card>
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing outstanding"
              hint={
                overdueOnly
                  ? 'No account is past its due date.'
                  : 'No customer has a balance on this date.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Account</th>
                    <th className={TABLE_TH}>Contact</th>
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
                        {/* One line, so rows hold their 36px height. */}
                        <div className="flex items-center gap-2">
                          <TextLink href={`/customers/${row.id}?tab=transactions`}>
                            {row.code}
                          </TextLink>
                          <span className="truncate text-ink">{row.name}</span>
                          {row.status !== 'active' && (
                            <Badge tone={row.status === 'on_hold' ? 'danger' : 'neutral'}>
                              {STATUS_LABELS[row.status] ?? row.status}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className={TABLE_TD}>
                        <div className="text-ink-2">{row.contactName ?? '—'}</div>
                        {row.phone && <div className="text-xs text-muted">{row.phone}</div>}
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
                  <tr className={TABLE_TOTAL_ROW}>
                    <td className={TABLE_TD} colSpan={2}>
                      {rows.length} account{rows.length === 1 ? '' : 's'}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {formatMoney(totals.current)}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(totals.d30)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(totals.d60)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(totals.d90)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(totals.d120)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/** A bucket cell. Zero is greyed so the eye lands on the money, not the noughts. */
function Bucket({ value, tone }: { value: number; tone?: 'warning' | 'danger' }) {
  const colour =
    value === 0 ? 'text-faint' : tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink-2'
  return <td className={`${TABLE_TD} ${TABLE_NUMERIC} ${colour}`}>{formatMoney(value)}</td>
}
