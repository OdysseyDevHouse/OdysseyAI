import { requireCapability } from '@/lib/auth'
import { balanceSheet } from '@/lib/site/financialStatements'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import {
  PageHeader,
  PageBody,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  EmptyState,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
  TABLE_TOTAL_ROW,
} from '@/components/ui'
import { AsAtForm } from './AsAtForm'

export const dynamic = 'force-dynamic'

/**
 * The balance sheet — what the business owns and owes, at a moment.
 *
 * ── WHY IT BALANCES ──────────────────────────────────────────────────────
 *
 * Assets = liabilities + equity, where equity includes profit earned and not
 * yet closed to retained earnings. That is not a rule imposed on the figures;
 * it falls out of every journal summing to zero. So when it does NOT balance,
 * something got into the ledger unbalanced — and that is shown loudly rather
 * than quietly absorbed, because every figure below it is then suspect.
 */
export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asAt?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reports.financial')
  const params = await searchParams

  const asAt = /^\d{4}-\d{2}-\d{2}$/.test(params.asAt ?? '') ? params.asAt! : today()
  const sheet = await balanceSheet(siteId, asAt)

  const hasActivity = sheet.assetsTotal !== 0 || sheet.liabilitiesTotal !== 0

  return (
    <>
      <PageHeader title="Balance sheet" subtitle={`As at ${asAt}`} action={<AsAtForm asAt={asAt} />} />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Assets" value={formatMoney(sheet.assetsTotal)} />
          <StatTile label="Liabilities" value={formatMoney(sheet.liabilitiesTotal)} />
          <StatTile
            label="Equity"
            value={formatMoney(sheet.totalEquityAndReserves)}
            hint="Including this year's result"
          />
          <StatTile
            label={sheet.balanced ? 'Balanced' : 'Out of balance'}
            value={sheet.balanced ? '✓' : formatMoney(Math.abs(sheet.outOfBalance))}
            tone={sheet.balanced ? 'positive' : 'danger'}
            hint={sheet.balanced ? 'Assets equal liabilities plus equity' : 'The ledger has a problem'}
          />
        </div>

        {/* Loud on purpose. Every figure below is suspect until this is fixed. */}
        {!sheet.balanced && (
          <Callout
            tone="danger"
            title="The books are out of balance"
            action={
              <ButtonLink href="/accounting/trial-balance" variant="secondary" size="sm">
                Check the trial balance
              </ButtonLink>
            }
          >
            Assets exceed liabilities and equity by {formatMoney(sheet.outOfBalance)}. An
            unbalanced entry reached the ledger — every figure here is suspect until it is found.
          </Callout>
        )}

        {!hasActivity ? (
          <Card>
            <CardBody>
              <EmptyState
                title="Nothing posted yet"
                hint="The balance sheet is built from the general ledger. It fills in as sales, purchases and expenses are captured."
              />
            </CardBody>
          </Card>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Assets" description="What the business owns." />
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Account</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.assets.map((group) => (
                      <Group key={group.subtype ?? group.label} group={group} />
                    ))}
                    <tr className={TABLE_TOTAL_ROW}>
                      <td className={`${TABLE_TD} font-semibold`}>Total assets</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-base font-semibold`}>
                        {formatMoney(sheet.assetsTotal)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Liabilities and equity"
                description="What it owes, and what belongs to the owners."
              />
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Account</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.liabilities.map((group) => (
                      <Group key={group.subtype ?? group.label} group={group} />
                    ))}
                    {sheet.liabilitiesTotal !== 0 && (
                      <tr className={TABLE_TOTAL_ROW}>
                        <td className={TABLE_TD}>Total liabilities</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(sheet.liabilitiesTotal)}
                        </td>
                      </tr>
                    )}

                    {sheet.equity.map((group) => (
                      <Group key={group.subtype ?? group.label} group={group} />
                    ))}

                    {/* Profit earned this year and not yet closed to retained
                        earnings. It belongs in equity — without it the sheet
                        would be out by exactly the profit made. */}
                    <tr className={TABLE_ROW}>
                      <td className={`${TABLE_TD} pl-8`}>
                        <span className="text-ink-2">
                          {sheet.currentYearResult >= 0 ? 'Profit' : 'Loss'} for the year
                        </span>
                        <span className="mt-0.5 block text-xs text-muted">
                          Not yet closed to retained earnings
                        </span>
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {formatMoney(sheet.currentYearResult)}
                      </td>
                    </tr>

                    <tr className={TABLE_TOTAL_ROW}>
                      <td className={`${TABLE_TD} font-semibold`}>
                        Total liabilities and equity
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-base font-semibold`}>
                        {formatMoney(sheet.liabilitiesTotal + sheet.totalEquityAndReserves)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </PageBody>
    </>
  )
}

function Group({
  group,
}: {
  group: {
    subtype: string | null
    label: string
    lines: { accountId: number; accountCode: string; name: string; amount: number }[]
    total: number
  }
}) {
  return (
    <>
      <tr className="bg-surface-2">
        <td className={`${TABLE_TD} font-medium text-ink`} colSpan={2}>
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
        </tr>
      ))}
    </>
  )
}
