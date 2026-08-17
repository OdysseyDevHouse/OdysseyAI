import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireModuleCapability } from '@/lib/auth'
import { getAccount } from '@/lib/site/chartOfAccounts'
import { accountLedger } from '@/lib/site/journals'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import { addDays } from '@/lib/site/interestRules'
import { CONTROL_SOURCE_HINTS } from '@/lib/glModel'
import {
  PageHeader,
  PageBody,
  Button,
  Card,
  CardHeader,
  CardBody,
  Field,
  Input,
  StatTile,
  EmptyState,
  Badge,
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
 * One account's entries — the drill-down behind every figure on a statement.
 *
 * A statement nobody can drill into is a statement nobody trusts. This is where
 * "why is rent R31 000" gets answered, so the running balance is the point and
 * the opening figure is carried in rather than starting from zero mid-history.
 */
export default async function AccountEnquiryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('accounting', 'reports.financial')
  const { id } = await params
  const search = await searchParams

  const accountId = Number(id)
  if (!Number.isFinite(accountId)) notFound()

  const account = await getAccount(siteId, accountId)
  if (!account) notFound()

  const to = /^\d{4}-\d{2}-\d{2}$/.test(search.to ?? '') ? search.to! : today()
  const from = /^\d{4}-\d{2}-\d{2}$/.test(search.from ?? '') ? search.from! : addDays(to, -90)

  const ledger = await accountLedger(siteId, accountId, { from, to })

  const movement = ledger.entries.reduce((sum, e) => sum + e.debit - e.credit, 0)

  return (
    <>
      <PageHeader
        title={`${account.accountCode} · ${account.name}`}
        subtitle={`${account.accountTypeLabel} · ${account.subtypeLabel}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {account.controlType && <Badge tone="brand">Control account</Badge>}
            {!account.isPostable && <Badge tone="default">Not directly postable</Badge>}
            {!account.isActive && <Badge tone="warning">Hidden</Badge>}
            <Badge tone="default">
              {account.statement === 'balance_sheet' ? 'Balance sheet' : 'Profit and loss'}
            </Badge>
          </div>
        }
      />

      <PageBody>
        {account.controlType && (
          <Card>
            <CardBody>
              <p className="text-sm text-muted">{CONTROL_SOURCE_HINTS[account.controlType]}</p>
            </CardBody>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Opening" value={formatMoney(ledger.opening)} hint={`Before ${from}`} />
          <StatTile
            label="Movement"
            value={formatMoney(movement)}
            hint={`${ledger.entries.length} entr${ledger.entries.length === 1 ? 'y' : 'ies'}`}
          />
          <StatTile label="Closing" value={formatMoney(ledger.closing)} hint={`At ${to}`} />
          <StatTile
            label="As shown on statements"
            value={formatMoney(account.displayBalance)}
            hint="Current balance, read the natural way"
          />
        </div>

        <Card>
          <CardHeader
            title="Entries"
            description={`${from} to ${to}, oldest first.`}
            action={
              /* A plain GET form: the range lives in the URL, so it survives a
                 reload and can be linked to — no client state needed. */
              <form
                action={`/accounting/accounts/${accountId}`}
                className="flex items-end gap-2"
              >
                <div className="w-40">
                  <Field label="From">
                    <Input type="date" name="from" defaultValue={from} />
                  </Field>
                </div>
                <div className="w-40">
                  <Field label="To">
                    <Input type="date" name="to" defaultValue={to} />
                  </Field>
                </div>
                <Button type="submit" variant="secondary">
                  Apply
                </Button>
              </form>
            }
          />
          {ledger.entries.length === 0 ? (
            <CardBody>
              <EmptyState
                title="Nothing in this period"
                hint="Try a wider date range — the opening balance above shows what came before it."
              />
            </CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Date</th>
                    <th className={TABLE_TH}>Journal</th>
                    <th className={TABLE_TH}>Description</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Debit</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Credit</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={TABLE_TOTAL_ROW}>
                    <td className={TABLE_TD} colSpan={5}>
                      Opening balance
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {formatMoney(ledger.opening)}
                    </td>
                  </tr>
                  {ledger.entries.map((e, i) => (
                    <tr key={`${e.batchId}-${i}`} className={TABLE_ROW}>
                      <td className={TABLE_TD}>{e.journalDate}</td>
                      <td className={TABLE_TD}>
                        <Link
                          href={`/accounting/journals/${e.batchId}`}
                          className="text-brand hover:underline"
                        >
                          {e.journalNumber ?? `#${e.batchId}`}
                        </Link>
                        {e.source !== 'manual' && (
                          <span className="ml-2 text-xs text-muted">
                            {e.source.replace('_', ' ')}
                          </span>
                        )}
                      </td>
                      <td className={TABLE_TD}>
                        <span className="text-ink-2">{e.lineDescription ?? e.description}</span>
                      </td>
                      {/* The running balance is what this screen exists for —
                          it carries the ink; the movements recede. */}
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                        {e.debit === 0 ? <span className="text-faint">—</span> : formatMoney(e.debit)}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>
                        {e.credit === 0 ? (
                          <span className="text-faint">—</span>
                        ) : (
                          formatMoney(e.credit)
                        )}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                        {formatMoney(e.balance)}
                      </td>
                    </tr>
                  ))}
                  <tr className={TABLE_TOTAL_ROW}>
                    <td className={`${TABLE_TD} font-semibold`} colSpan={5}>
                      Closing balance
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                      {formatMoney(ledger.closing)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}
