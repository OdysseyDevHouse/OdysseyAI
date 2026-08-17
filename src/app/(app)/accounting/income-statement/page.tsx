import { Fragment } from 'react'
import { requireModuleCapability } from '@/lib/auth'
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
  searchParams: Promise<{ from?: string; to?: string; period?: string; budget?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('accounting', 'reports.financial')
  const params = await searchParams
  const withBudget = params.budget === '1'

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

  // One comparison at a time: prior period OR budget. Both at once is seven
  // numeric columns, and the one that matters drowns.
  const statement = await incomeStatement(siteId, range, {
    compare: !withBudget,
    budget: withBudget,
  })
  const href = hrefBuilder('/accounting/income-statement', params)

  const hasActivity = statement.revenueTotal !== 0 || statement.expenseTotal !== 0

  const mode: CompareMode = withBudget ? 'budget' : statement.prior ? 'prior' : 'none'
  const compareTotals = withBudget ? statement.budget : statement.prior

  return (
    <>
      <PageHeader
        title="Profit and loss"
        subtitle={`${range.from} to ${range.to}`}
      />

      <PageBody>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <LinkTabs
            items={Object.entries(presets).map(([key, p]) => ({
              value: key,
              label: p.label,
              href: href({ period: key, from: null, to: null }),
            }))}
            value={params.from ? 'custom' : preset}
            aria-label="Period"
          />
          <LinkTabs
            items={[
              { value: 'prior', label: 'vs prior period', href: href({ budget: null }) },
              { value: 'budget', label: 'vs budget', href: href({ budget: '1' }) },
            ]}
            value={withBudget ? 'budget' : 'prior'}
            aria-label="Comparison"
          />
        </div>

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
              description={
                withBudget
                  ? 'Against what was budgeted for the calendar months this period touches — whole months, not prorated.'
                  : statement.prior
                    ? 'Against the preceding period of the same length.'
                    : undefined
              }
            />
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Account</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>This period</th>
                    {mode === 'prior' && (
                      <>
                        <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Prior</th>
                        <th className={`${TABLE_TH} ${TABLE_NUMERIC} w-24`}>Change</th>
                      </>
                    )}
                    {mode === 'budget' && (
                      <>
                        <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Budget</th>
                        <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Variance</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  <Section groups={statement.revenue} mode={mode} />
                  <Subtotal
                    label="Revenue"
                    amount={statement.revenueTotal}
                    compare={compareTotals?.revenueTotal}
                    mode={mode}
                  />

                  <Section groups={statement.costOfSales} mode={mode} />
                  {statement.costOfSalesTotal !== 0 && (
                    <Subtotal
                      label="Cost of sales"
                      amount={statement.costOfSalesTotal}
                      compare={compareTotals?.costOfSalesTotal}
                      mode={mode}
                    />
                  )}

                  <Subtotal
                    label="Gross profit"
                    amount={statement.grossProfit}
                    compare={compareTotals?.grossProfit}
                    mode={mode}
                    strong
                  />

                  <Section groups={statement.expenses} mode={mode} />
                  <Subtotal
                    label="Total expenses"
                    amount={statement.expenseTotal}
                    compare={compareTotals?.expenseTotal}
                    mode={mode}
                  />

                  <Subtotal
                    label={statement.netProfit >= 0 ? 'Net profit' : 'Net loss'}
                    amount={statement.netProfit}
                    compare={compareTotals?.netProfit}
                    mode={mode}
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

type CompareMode = 'prior' | 'budget' | 'none'

function Section({
  groups,
  mode,
}: {
  groups: { subtype: string | null; label: string; lines: { accountId: number; accountCode: string; name: string; amount: number; priorAmount?: number; budgetAmount?: number }[]; total: number }[]
  mode: CompareMode
}) {
  return (
    <>
      {groups.map((group) => (
        <Fragment key={group.subtype ?? group.label}>
          <tr className="bg-surface-2">
            <td className={`${TABLE_TD} font-medium text-ink`} colSpan={mode === 'none' ? 2 : 4}>
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
              {mode === 'prior' && (
                <>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                    {formatMoney(line.priorAmount ?? 0)}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <Change current={line.amount} prior={line.priorAmount ?? 0} />
                  </td>
                </>
              )}
              {mode === 'budget' && (
                <>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                    {formatMoney(line.budgetAmount ?? 0)}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    <Variance actual={line.amount} budget={line.budgetAmount ?? 0} />
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
  compare,
  mode,
  strong,
  highlight,
}: {
  label: string
  amount: number
  /** The prior-period or budget figure, per the mode. */
  compare?: number
  mode: CompareMode
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
      {mode !== 'none' && (
        <>
          <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>{formatMoney(compare ?? 0)}</td>
          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
            {mode === 'prior' ? (
              <Change current={amount} prior={compare ?? 0} />
            ) : (
              <Variance actual={amount} budget={compare ?? 0} />
            )}
          </td>
        </>
      )}
    </tr>
  )
}

/**
 * Actual against budget, as a signed amount.
 *
 * A plain figure, deliberately: whether "over" is good news depends on
 * whether the line is revenue or a cost, and colouring it without knowing
 * would congratulate an expense overrun as often as a sales beat.
 */
function Variance({ actual, budget }: { actual: number; budget: number }) {
  const diff = Math.round((actual - budget) * 100) / 100
  if (budget === 0 && actual === 0) return <span className="text-faint">—</span>
  if (diff === 0) return <span className="text-faint">On budget</span>
  return (
    <span className="text-ink-2">
      {diff > 0 ? '+' : ''}
      {formatMoney(diff)}
    </span>
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
