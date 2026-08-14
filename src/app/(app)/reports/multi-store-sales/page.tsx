import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { groupScopeFor, salesByStore, type SalesGrain } from '@/lib/groupReporting'
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
  StatStrip,
  StatTile,
  EmptyState,
  Badge,
  ButtonLink,
  LinkTabs,
  Icons,
  StoreColumnTable,
  type StoreRow,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * Turnover per store, day by day or month by month.
 *
 * The report a chain asks for first, and the one a spreadsheet is usually doing
 * badly: a store per column, a date per row. Which stores are growing and which
 * are quietly sliding is not answerable from any single-store screen, however
 * many of them you open.
 *
 * A dash means the store did not trade that day. Over a range that spans an
 * opening, the alternative — printing R0.00 for every day before it opened —
 * would read as months of catastrophic trading rather than a store that did not
 * exist yet.
 */
export default async function MultiStoreSalesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; period?: string; grain?: string }>
}) {
  const { site, user, capabilities } = await requireSiteUser()
  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'reports.view')) redirect('/not-allowed')
  if (user.controlUserId === null) redirect('/not-allowed')

  const scope = await groupScopeFor(site.id, user.controlUserId, 'reports.view')

  if (!scope || scope.sites.length === 0) {
    return (
      <>
        <PageHeader title="Sales by store" subtitle="Turnover across every linked store" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title="This store is not linked to any others"
                hint="Link stores together to compare their trading. Linking lives under Setup."
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
  const presets: Record<string, { from: string; to: string; label: string; grain: SalesGrain }> = {
    month: { from: `${now.slice(0, 7)}-01`, to: now, label: 'This month', grain: 'day' },
    quarter: { from: addDays(now, -90), to: now, label: 'Last 90 days', grain: 'day' },
    year: { from: `${now.slice(0, 4)}-01-01`, to: now, label: 'This year', grain: 'month' },
  }
  const chosen = presets[preset] ?? presets.month
  const range = {
    from: /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '') ? params.from! : chosen.from,
    to: /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '') ? params.to! : chosen.to,
  }
  // The preset picks a sensible default, and the toggle overrides it — a year
  // of daily rows is 365 lines nobody reads, but somebody may still want it.
  const grain: SalesGrain = params.grain === 'day' || params.grain === 'month'
    ? params.grain
    : chosen.grain

  const href = hrefBuilder('/reports/multi-store-sales', params)
  const report = await salesByStore(scope.sites, range, grain)

  const rows: StoreRow[] = report.periods.map((p) => ({
    key: p.period,
    label: <span className="text-ink-2">{p.period}</span>,
    values: p.perSite,
  }))

  const best = report.perSiteTotals.reduce(
    (top, v, i) => (v > (report.perSiteTotals[top] ?? -Infinity) ? i : top),
    0,
  )

  return (
    <>
      <PageHeader
        title="Sales by store"
        subtitle={`${scope.group.name} — ${range.from} to ${range.to}`}
      />
      <PageBody>
        <LinkTabs
          items={Object.entries(presets).map(([key, p]) => ({
            value: key,
            label: p.label,
            href: href({ period: key, from: null, to: null, grain: null }),
          }))}
          value={params.from ? 'custom' : preset}
          aria-label="Period"
        />

        <StatStrip columns={3}>
          <StatTile
            label="Group turnover"
            value={formatMoney(report.total)}
            hint={`${report.periods.length} ${grain === 'month' ? 'months' : 'days'} of trading`}
            icon={<Icons.Coins size={20} />}
            iconTone="success"
          />
          <StatTile
            label="Stores trading"
            value={String(report.sites.length)}
            hint={report.failures.length > 0 ? `${report.failures.length} could not be read` : 'All reporting'}
            tone={report.failures.length > 0 ? 'warning' : 'default'}
            icon={<Icons.Store size={20} />}
          />
          <StatTile
            label="Busiest store"
            value={report.sites[best]?.name ?? '—'}
            hint={report.perSiteTotals[best] ? formatMoney(report.perSiteTotals[best]) : undefined}
            icon={<Icons.BarChart size={20} />}
          />
        </StatStrip>

        {report.failures.length > 0 && (
          <Card>
            <CardBody>
              <p className="text-sm">
                <Badge tone="warning">Some stores could not be read</Badge>
                <span className="ml-2 text-muted">
                  {report.failures.map((f) => `${f.name}: ${f.error}`).join('; ')} — their columns
                  are left out rather than shown as zero.
                </span>
              </p>
            </CardBody>
          </Card>
        )}

        {report.periods.length === 0 ? (
          <Card>
            <CardBody>
              <EmptyState
                title="Nothing sold in this period"
                hint="Choose a different period, or check that the linked stores have finalised sales in this range."
              />
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardHeader
              title={grain === 'month' ? 'By month' : 'By day'}
              description="Finalised invoices and credit sales, VAT inclusive, by document date."
              action={
                <LinkTabs
                  items={[
                    { value: 'day', label: 'Daily', href: href({ grain: 'day' }) },
                    { value: 'month', label: 'Monthly', href: href({ grain: 'month' }) },
                  ]}
                  value={grain}
                  aria-label="Detail"
                />
              }
            />
            <StoreColumnTable
              columns={report.sites.map((s) => ({ siteId: s.siteId, name: s.name }))}
              rows={rows}
              format={formatMoney}
              firstHeading={grain === 'month' ? 'Month' : 'Date'}
              totalsRow={report.perSiteTotals}
              emptyNote="A dash means that store recorded no sales in the period — which is not the same as a day it traded and took nothing."
            />
          </Card>
        )}
      </PageBody>
    </>
  )
}
