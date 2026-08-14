import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { groupScopeFor, groupDashboard } from '@/lib/groupReporting'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import {
  PageHeader,
  PageBody,
  Card,
  CardBody,
  CardHeader,
  StatTile,
  EmptyState,
  Badge,
  ButtonLink,
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
 * The group overview — every linked store's trading, side by side.
 *
 * A store appears only when THIS user may open it and their role there grants
 * the dashboard; anything else is listed under the table with its reason.
 * A store whose database cannot be read renders an error chip in its row —
 * one broken store must never blank the other four.
 */
export default async function GroupOverviewPage() {
  const { site, user, capabilities } = await requireSiteUser()
  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'dashboard.view')) redirect('/not-allowed')
  if (user.controlUserId === null) redirect('/not-allowed')

  const scope = await groupScopeFor(site.id, user.controlUserId, 'dashboard.view')

  if (!scope || scope.sites.length === 0) {
    return (
      <>
        <PageHeader title="Group overview" subtitle="Every linked store, side by side" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title="This store is not linked to a group"
                hint="Link stores into a group to see their trading side by side. Grouping lives under Setup."
                action={<ButtonLink href="/setup/linked-stores" variant="secondary">Open linked stores</ButtonLink>}
              />
            </CardBody>
          </Card>
        </PageBody>
      </>
    )
  }

  const now = today()
  const rows = await groupDashboard(scope.sites, {
    todayIso: now,
    monthFrom: `${now.slice(0, 7)}-01`,
    monthTo: now,
  })

  const showGp = can(capabilities, 'products.cost')
  const okRows = rows.filter((r) => r.ok)
  const sum = (pick: (r: (typeof okRows)[number] & { ok: true }) => number) =>
    okRows.reduce((t, r) => (r.ok ? t + pick(r) : t), 0)

  const todayTotal = sum((r) => r.data.today.turnoverIncl)
  const monthTotal = sum((r) => r.data.month.turnoverIncl)
  const gpTotal = sum((r) => r.data.month.grossProfit)
  const stockTotal = sum((r) => r.data.stockValue)

  return (
    <>
      <PageHeader title="Group overview" subtitle={scope.group.name} />
      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Today, all stores" value={formatMoney(todayTotal)} />
          <StatTile label="This month" value={formatMoney(monthTotal)} />
          {showGp ? (
            <StatTile label="Gross profit (month)" value={formatMoney(gpTotal)} tone="positive" />
          ) : (
            <StatTile label="Stores trading" value={String(okRows.length)} />
          )}
          <StatTile label="Stock at cost" value={formatMoney(stockTotal)} />
        </div>

        <Card>
          <CardHeader
            title="By store"
            description={`Today is ${now}; the month runs from the 1st. Figures come from each store's own records.`}
          />
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Store</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Sales today</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Today</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Month</th>
                  {showGp && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>GP (month)</th>}
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Stock at cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.siteId} className={TABLE_ROW}>
                    <td className={`${TABLE_TD} font-medium text-ink`}>
                      {row.name}
                      {scope.sites.find((s) => s.siteId === row.siteId)?.isPrimary && (
                        <span className="ml-2 align-middle"><Badge tone="brand">Primary</Badge></span>
                      )}
                    </td>
                    {row.ok ? (
                      <>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{row.data.today.saleCount}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(row.data.today.turnoverIncl)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(row.data.month.turnoverIncl)}
                        </td>
                        {showGp && (
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                            {formatMoney(row.data.month.grossProfit)}
                          </td>
                        )}
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(row.data.stockValue)}
                        </td>
                      </>
                    ) : (
                      <td className={TABLE_TD} colSpan={showGp ? 5 : 4}>
                        <Badge tone="warning">Could not read this store</Badge>
                        <span className="ml-2 text-xs text-muted">{row.error}</span>
                      </td>
                    )}
                  </tr>
                ))}
                <tr className={TABLE_TOTAL_ROW}>
                  <td className={`${TABLE_TD} font-semibold`}>All stores</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                    {okRows.reduce((t, r) => (r.ok ? t + r.data.today.saleCount : t), 0)}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>{formatMoney(todayTotal)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>{formatMoney(monthTotal)}</td>
                  {showGp && (
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>{formatMoney(gpTotal)}</td>
                  )}
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>{formatMoney(stockTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        {scope.excluded.length > 0 && (
          <Card>
            <CardBody>
              <p className="text-sm text-muted">
                Not shown:{' '}
                {scope.excluded
                  .map((e) =>
                    e.reason === 'no-access'
                      ? `${e.name} (you do not have access to this store)`
                      : `${e.name} (your role at this store does not include the dashboard)`,
                  )
                  .join('; ')}
                . Store access is granted per store, under each store&apos;s own users and roles.
              </p>
            </CardBody>
          </Card>
        )}
      </PageBody>
    </>
  )
}
