import { Fragment } from 'react'
import { requireCapability } from '@/lib/auth'
import { cashFlowStatement, type CashFlowGroup } from '@/lib/site/cashFlowStatement'
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
  Callout,
  StatTile,
  EmptyState,
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
 * Cash flow — the profit was made, so where is the money?
 *
 * Indirect method: start from the period's result, add back what never moved
 * cash, then show the working capital, investing and financing movements that
 * explain the change in the bank. The bottom line MUST equal closing cash
 * less opening cash — every journal sums to zero, so anything unexplained is
 * a posting bug, and the statement says so rather than hiding it.
 */
export default async function CashFlowPage({
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

  const statement = await cashFlowStatement(siteId, range)
  const href = hrefBuilder('/accounting/cash-flow', params)

  const hasActivity =
    statement.netCashMovement !== 0 ||
    statement.netResult !== 0 ||
    statement.operating.lines.length > 0

  return (
    <>
      <PageHeader title="Cash flow" subtitle={`${range.from} to ${range.to}`} />

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

        {!statement.balanced && (
          <Callout tone="danger" title="This statement does not reconcile">
            The change in cash is {formatMoney(statement.netCashMovement)} but the sections
            explain {formatMoney(statement.netCashMovement - statement.unexplained)} of it —
            {' '}{formatMoney(Math.abs(statement.unexplained))} is unaccounted for. That means an
            unbalanced journal reached the ledger. Check ledger health on the trial balance.
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Operating" value={formatMoney(statement.operatingTotal)} />
          <StatTile label="Investing" value={formatMoney(statement.investing.total)} />
          <StatTile label="Financing" value={formatMoney(statement.financing.total)} />
          {/* The one figure everyone opened this screen for. */}
          <StatTile
            label={statement.netCashMovement >= 0 ? 'Cash generated' : 'Cash consumed'}
            value={formatMoney(Math.abs(statement.netCashMovement))}
            tone={statement.netCashMovement >= 0 ? 'positive' : 'danger'}
            hint={`${formatMoney(statement.openingCash)} → ${formatMoney(statement.closingCash)}`}
          />
        </div>

        {!hasActivity ? (
          <Card>
            <CardBody>
              <EmptyState
                title="Nothing moved in this period"
                hint="The cash flow is built from the general ledger. It fills in as sales, purchases and payments post."
              />
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardHeader
              title="Cash flow statement"
              description="Indirect method — from the period's result to the change in the bank."
            />
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Movement</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <GroupHeader label="Operating activities" />
                  <Line
                    label={statement.netResult >= 0 ? 'Net result for the period' : 'Net loss for the period'}
                    amount={statement.netResult}
                  />
                  {statement.nonCashAdjustments !== 0 && (
                    <Line
                      label="Non-cash movements added back"
                      hint="Depreciation and asset disposals — costs that moved no money."
                      amount={statement.nonCashAdjustments}
                    />
                  )}
                  {statement.operating.lines.map((line) => (
                    <AccountLine key={line.accountId} line={line} />
                  ))}
                  <Subtotal label="Cash from operations" amount={statement.operatingTotal} strong />

                  <SectionRows group={statement.investing} emptyLabel="No investing movements" />
                  <SectionRows group={statement.financing} emptyLabel="No financing movements" />
                  {statement.other.lines.length > 0 && <SectionRows group={statement.other} />}

                  <Subtotal
                    label={statement.netCashMovement >= 0 ? 'Net increase in cash' : 'Net decrease in cash'}
                    amount={statement.netCashMovement}
                    strong
                    highlight
                  />
                  <Subtotal label="Opening cash" amount={statement.openingCash} />
                  <Subtotal label="Closing cash" amount={statement.closingCash} strong />
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card>
          <CardBody>
            <p className="text-sm text-muted">
              Built from the general ledger. Positive figures generated cash; negative ones
              consumed it — stock filling up or debtors growing uses money even in a profitable
              month, which is exactly what this statement exists to show. Year-end closes are
              excluded (they move nothing), and depreciation is added back where it belongs.
            </p>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}

function GroupHeader({ label }: { label: string }) {
  return (
    <tr className="bg-surface-2">
      <td className={`${TABLE_TD} font-medium text-ink`} colSpan={2}>
        {label}
      </td>
    </tr>
  )
}

function Line({ label, amount, hint }: { label: string; amount: number; hint?: string }) {
  return (
    <tr className={TABLE_ROW}>
      <td className={`${TABLE_TD} pl-8`}>
        <span className="text-ink-2">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </td>
      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(amount)}</td>
    </tr>
  )
}

function AccountLine({
  line,
}: {
  line: { accountId: number; accountCode: string; name: string; amount: number }
}) {
  return (
    <tr className={TABLE_ROW}>
      <td className={`${TABLE_TD} pl-8`}>
        <span className="text-ink-2">{line.name}</span>
        <span className="ml-2 text-xs text-muted">{line.accountCode}</span>
      </td>
      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(line.amount)}</td>
    </tr>
  )
}

function SectionRows({ group, emptyLabel }: { group: CashFlowGroup; emptyLabel?: string }) {
  return (
    <Fragment>
      <GroupHeader label={group.label} />
      {group.lines.length === 0 ? (
        <tr className={TABLE_ROW}>
          <td className={`${TABLE_TD} pl-8 text-faint`} colSpan={2}>
            {emptyLabel ?? 'Nothing in this period'}
          </td>
        </tr>
      ) : (
        group.lines.map((line) => <AccountLine key={line.accountId} line={line} />)
      )}
      <Subtotal label={`Cash from ${group.label.toLowerCase()}`} amount={group.total} />
    </Fragment>
  )
}

function Subtotal({
  label,
  amount,
  strong,
  highlight,
}: {
  label: string
  amount: number
  strong?: boolean
  highlight?: boolean
}) {
  return (
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
    </tr>
  )
}
