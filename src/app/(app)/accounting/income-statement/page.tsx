import { Fragment } from 'react'
import { requireCapability } from '@/lib/auth'
import { incomeStatement } from '@/lib/site/financialStatements'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import { addDays } from '@/lib/site/interestRules'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  EmptyState,
  Badge,
  LinkTabs,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
  TABLE_TOTAL_ROW,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * Profit and loss — did we make money?
 *
 * The one question the system could never answer before the ledger existed.
 *
 * Structured the way an accountant reads it, top to bottom: revenue, less cost
 * of sales, gross profit, less expenses, net profit. The two profit lines are
 * the only ones given weight, because they are the two figures anyone actually
 * came for.
 */
export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; period?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reports.financial')
  const params = await searchParams

  const now = today()
  const preset = params.period ?? 'month'
  const presets: Record<string, { from: string; to: string; label: string }> = {
    month: { from: `${now.slice(0, 7)}-01`, to: now, label: 'This month' },
    quarter: { from: addDays(now, -90), to: now, label: 'Last 90 days' },
    year: { from: `${now.slice(0, 4)}-01-01`, to: now, label: 'This year' },
  }

  const chosen = presets[preset] ?? presets.month
  const range = {
    from: /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '') ? params.from! : chosen.from,
    to: /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '') ? params.to! : chosen.to,
  }

  const statement = await incomeStatement(siteId, range, { compare: true })
  const href = hrefBuilder('/accounting/income-statement', params)

  const hasActivity = statement.revenueTotal !== 0 || statement.expenseTotal !== 0

  return (
    <>
      <PageHeader
        title="Profit and loss"
        subtitle={`${range.from} to ${range.to}`}
      />

      <PageBody>
        <LinkTabs
          items={Object.entries(presets).map(([key, p]) => ({
            value: key,
            label: p.label,
            href: href({ period: key, from: null, to: null }),
          }))}
          value={params.from ? 'custom' : preset}
          aria-label="Period"
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Revenue" value={formatMoney(statement.revenueTotal)} />
          <StatTile
            label="Gross profit"
            value={formatMoney(statement.grossProfit)}
            hint={statement.grossMarginPct !== null ? `${statement.grossMarginPct}% margin` : undefined}
          />
          <StatTile label="Expenses" value={formatMoney(statement.expenseTotal)} />
          {/* The one figure everyone opened this screen for. */}
          <StatTile
            label={statement.netProfit >= 0 ? 'Net profit' : 'Net loss'}
            value={formatMoney(Math.abs(statement.netProfit))}
            tone={statement.netProfit >= 0 ? 'positive' : 'danger'}
            hint={statement.netMarginPct !== null ? `${statement.netMarginPct}% of revenue` : undefined}
          />
        </div>

        {!hasActivity ? (
          <Card>
            <CardBody>
              <EmptyState
                title="Nothing posted in this period"
                hint="The profit and loss is built from the general ledger. Sales, expenses and purchases post to it as they are captured."
              />
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardHeader
              title="Profit and loss"
              description={statement.prior ? 'Against the preceding period of the same length.' : undefined}
            />
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Account</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>This period</th>
                    {statement.prior && (
                      <>
                        <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Prior</th>
                        <th className={`${TABLE_TH} ${TABLE_NUMERIC} w-24`}>Change</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  <Section
                    groups={statement.revenue}
                    hasPrior={statement.prior !== null}
                  />
                  <Subtotal
                    label="Revenue"
                    amount={statement.revenueTotal}
                    prior={statement.prior?.revenueTotal}
                    hasPrior={statement.prior !== null}
                  />

                  <Section groups={statement.costOfSales} hasPrior={statement.prior !== null} />
                  {statement.costOfSalesTotal !== 0 && (
                    <Subtotal
                      label="Cost of sales"
                      amount={statement.costOfSalesTotal}
                      prior={statement.prior?.costOfSalesTotal}
                      hasPrior={statement.prior !== null}
                    />
                  )}

                  <Subtotal
                    label="Gross profit"
                    amount={statement.grossProfit}
                    prior={statement.prior?.grossProfit}
                    hasPrior={statement.prior !== null}
                    strong
                  />

                  <Section groups={statement.expenses} hasPrior={statement.prior !== null} />
                  <Subtotal
                    label="Total expenses"
                    amount={statement.expenseTotal}
                    prior={statement.prior?.expenseTotal}
                    hasPrior={statement.prior !== null}
                  />

                  <Subtotal
                    label={statement.netProfit >= 0 ? 'Net profit' : 'Net loss'}
                    amount={statement.netProfit}
                    prior={statement.prior?.netProfit}
                    hasPrior={statement.prior !== null}
                    strong
                    highlight
                  />
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card>
          <CardBody>
            <p className="text-sm text-muted">
              Built from the general ledger, so it includes everything posted through sales,
              purchasing, expenses and manual journals. Capital purchases are excluded — they are
              assets on the balance sheet rather than costs. Check the trial balance if anything
              here looks wrong: a profit and loss can only be as sound as the ledger behind it.
            </p>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}

function Section({
  groups,
  hasPrior,
}: {
  groups: { subtype: string | null; label: string; lines: { accountId: number; accountCode: string; name: string; amount: number; priorAmount?: number }[]; total: number }[]
  hasPrior: boolean
}) {
  return (
    <>
      {groups.map((group) => (
        <Fragment key={group.subtype ?? group.label}>
          <tr className="bg-surface-2">
            <td className={`${TABLE_TD} font-medium text-ink`} colSpan={hasPrior ? 4 : 2}>
              {group.label}
            </td>
          </tr>
          {group.lines.map((line) => (
            <tr key={line.accountId} className={TABLE_ROW}>
              <td className={`${TABLE_TD} pl-8`}>
                <span className="text-ink-2">{line.name}</span>
                <span className="ml-2 text-xs text-muted">{line.accountCode}</span>
              </td>
              <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(line.amount)}</td>
              {hasPrior && (
                <>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                    {formatMoney(line.priorAmount ?? 0)}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <Change current={line.amount} prior={line.priorAmount ?? 0} />
                  </td>
                </>
              )}
            </tr>
          ))}
        </Fragment>
      ))}
    </>
  )
}

function Subtotal({
  label,
  amount,
  prior,
  hasPrior,
  strong,
  highlight,
}: {
  label: string
  amount: number
  prior?: number
  hasPrior: boolean
  strong?: boolean
  highlight?: boolean
}) {
  return (
    /* The headline (net profit) row wears a brand tint and a double rule so it
       cannot be mistaken for a group header — both used to be bg-surface-2. */
    <tr
      className={
        highlight
          ? 'border-t-4 border-double border-border bg-brand-soft font-medium text-ink'
          : TABLE_TOTAL_ROW
      }
    >
      <td className={`${TABLE_TD} ${strong ? 'font-semibold' : ''}`}>{label}</td>
      <td className={`${TABLE_TD} ${TABLE_NUMERIC} ${strong ? 'text-base font-semibold' : ''}`}>
        {formatMoney(amount)}
      </td>
      {hasPrior && (
        <>
          <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>{formatMoney(prior ?? 0)}</td>
          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
            <Change current={amount} prior={prior ?? 0} />
          </td>
        </>
      )}
    </tr>
  )
}

/**
 * Change against the prior period.
 *
 * Only shown when it is material — a 2% move on every line is noise that buries
 * the one line that moved 60%.
 */
function Change({ current, prior }: { current: number; prior: number }) {
  if (prior === 0) {
    return current === 0 ? <span className="text-faint">—</span> : <Badge tone="brand">New</Badge>
  }
  const pct = Math.round(((current - prior) / Math.abs(prior)) * 100)
  if (Math.abs(pct) < 10) return <span className="text-faint">—</span>

  // One tone for ordinary moves; colour is spent only on the outsized ones.
  return (
    <span className={Math.abs(pct) >= 50 ? 'text-warning-ink' : 'text-ink-2'}>
      {pct > 0 ? '+' : ''}
      {pct}%
    </span>
  )
}
