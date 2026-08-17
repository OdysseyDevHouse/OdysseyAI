import { Fragment } from 'react'
import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { has } from '@/lib/control/modules'
import {
  groupScopeFor,
  consolidatedIncomeStatement,
  type ConsolidatedBlock,
} from '@/lib/groupReporting'
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
  ButtonLink,
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
 * One P&L across every linked store — a column per store, summed by account
 * code, because every store seeds the same chart and ids differ per database.
 *
 * A SIMPLE consolidation, and the footer says so: each store's own statement
 * is summed as-is; sales between linked stores are not eliminated.
 *
 * The route is a SIBLING of /reports/multi-store, not a child of it. The two
 * are peers — one report each — and `breadcrumbFor` builds a middle crumb from
 * any named screen that is a proper prefix, so nesting the URL would render
 * "Reports › Multi-store overview › Multi-store profit and loss" and claim this
 * lives inside the overview.
 */
export default async function MultiStoreIncomeStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; period?: string }>
}) {
  const { site, user, capabilities, modules } = await requireSiteUser()
  /* Module before capability: "your shop has not bought Multi-Branch" and
     "your role does not include this" are fixed by different people. */
  if (!has(modules, 'multi_branch')) redirect('/upgrade?module=multi_branch')

  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'reports.financial')) redirect('/not-allowed')
  if (user.controlUserId === null) redirect('/not-allowed')

  const scope = await groupScopeFor(site.id, user.controlUserId, 'reports.financial')

  if (!scope || scope.sites.length === 0) {
    return (
      <>
        <PageHeader title="Multi-store profit and loss" subtitle="One statement across every linked store" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title="This store is not linked to any others"
                hint="Link stores together to consolidate their statements. Linking lives under Setup."
                action={<ButtonLink href="/setup/linked-stores" variant="secondary">Open linked stores</ButtonLink>}
              />
            </CardBody>
          </Card>
        </PageBody>
      </>
    )
  }

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
  const href = hrefBuilder('/reports/multi-store-income-statement', params)

  const statement = await consolidatedIncomeStatement(scope.sites, range)
  const hasActivity = statement.revenueTotal !== 0 || statement.expenseTotal !== 0
  const columns = statement.sites

  return (
    <>
      <PageHeader title="Multi-store profit and loss" subtitle={`${scope.group.name} — ${range.from} to ${range.to}`} />
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
          <StatTile label="Gross profit" value={formatMoney(statement.grossProfit)} />
          <StatTile label="Expenses" value={formatMoney(statement.expenseTotal)} />
          <StatTile
            label={statement.netProfit >= 0 ? 'Net profit' : 'Net loss'}
            value={formatMoney(Math.abs(statement.netProfit))}
            tone={statement.netProfit >= 0 ? 'positive' : 'danger'}
          />
        </div>

        {statement.failures.length > 0 && (
          <Card>
            <CardBody>
              <p className="text-sm">
                <Badge tone="warning">Some stores could not be read</Badge>
                <span className="ml-2 text-muted">
                  {statement.failures.map((f) => `${f.name}: ${f.error}`).join('; ')} — their columns are
                  left out rather than shown as zero.
                </span>
              </p>
            </CardBody>
          </Card>
        )}

        {!hasActivity ? (
          <Card>
            <CardBody>
              <EmptyState
                title="Nothing posted in this period"
                hint="The consolidated statement is built from each store's general ledger."
              />
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardHeader
              tone="default"
              title="Profit and loss, by store"
              description="Accounts are matched across stores by their code. A dash means the account does not exist at that store."
            />
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Account</th>
                    {columns.map((c) => (
                      <th key={c.siteId} className={`${TABLE_TH} ${TABLE_NUMERIC}`}>
                        {c.name}
                      </th>
                    ))}
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  <Section blocks={statement.revenue} columnCount={columns.length} />
                  <Subtotal
                    label="Revenue"
                    perSite={statement.perSiteRevenue}
                    total={statement.revenueTotal}
                  />

                  <Section blocks={statement.costOfSales} columnCount={columns.length} />
                  {statement.costOfSalesTotal !== 0 && (
                    <Subtotal
                      label="Cost of sales"
                      perSite={statement.costOfSales.reduce(
                        (acc, b) => acc.map((v, i) => v + b.perSiteTotals[i]),
                        columns.map(() => 0),
                      )}
                      total={statement.costOfSalesTotal}
                    />
                  )}

                  <Subtotal
                    label="Gross profit"
                    perSite={columns.map((_, i) =>
                      round2(
                        statement.perSiteRevenue[i] -
                          statement.costOfSales.reduce((t, b) => t + b.perSiteTotals[i], 0),
                      ),
                    )}
                    total={statement.grossProfit}
                    strong
                  />

                  <Section blocks={statement.expenses} columnCount={columns.length} />
                  <Subtotal
                    label="Total expenses"
                    perSite={statement.expenses.reduce(
                      (acc, b) => acc.map((v, i) => round2(v + b.perSiteTotals[i])),
                      columns.map(() => 0),
                    )}
                    total={statement.expenseTotal}
                  />

                  <Subtotal
                    label={statement.netProfit >= 0 ? 'Net profit' : 'Net loss'}
                    perSite={statement.perSiteNet}
                    total={statement.netProfit}
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
              This is a simple sum of each store&apos;s own profit and loss — the same figures each
              store sees on its own statement, matched by account code. Sales between linked stores
              are not eliminated, so goods sold from one store to another count in both the seller&apos;s
              revenue and the buyer&apos;s costs.
            </p>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function Section({ blocks, columnCount }: { blocks: ConsolidatedBlock[]; columnCount: number }) {
  return (
    <>
      {blocks.map((block) => (
        <Fragment key={block.subtype ?? block.label}>
          <tr className="bg-surface-2">
            <td className={`${TABLE_TD} font-medium text-ink`} colSpan={columnCount + 2}>
              {block.label}
            </td>
          </tr>
          {block.lines.map((line) => (
            <tr key={line.accountCode} className={TABLE_ROW}>
              <td className={`${TABLE_TD} pl-8`}>
                <span className="text-ink-2">{line.name}</span>
                <span className="ml-2 text-xs text-muted">{line.accountCode}</span>
              </td>
              {line.perSite.map((amount, i) => (
                <td key={i} className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {amount === null ? <span className="text-faint">—</span> : formatMoney(amount)}
                </td>
              ))}
              <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium`}>{formatMoney(line.total)}</td>
            </tr>
          ))}
        </Fragment>
      ))}
    </>
  )
}

function Subtotal({
  label,
  perSite,
  total,
  strong,
  highlight,
}: {
  label: string
  perSite: number[]
  total: number
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
      {perSite.map((amount, i) => (
        <td key={i} className={`${TABLE_TD} ${TABLE_NUMERIC} ${strong ? 'font-semibold' : ''}`}>
          {formatMoney(amount)}
        </td>
      ))}
      <td className={`${TABLE_TD} ${TABLE_NUMERIC} ${strong ? 'text-base font-semibold' : ''}`}>
        {formatMoney(total)}
      </td>
    </tr>
  )
}
