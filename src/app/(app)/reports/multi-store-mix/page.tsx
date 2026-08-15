import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import {
  groupScopeFor,
  departmentsByStore,
  tendersByStore,
  hoursByStore,
  type KeyedReport,
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
  StatStrip,
  StatTile,
  EmptyState,
  Badge,
  ButtonLink,
  LinkTabs,
  Icons,
  MeterBar,
  StoreColumnTable,
  type StoreRow,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * What the group sells, how it gets paid, and when it is busy.
 *
 * Three cuts of one question — where turnover comes from — so they are three
 * tabs rather than three menu entries. Each is a keyed merge across stores:
 * departments by name, tenders by code, hours by the clock. A store that does
 * not run a department, or does not accept a tender, keeps a dash rather than a
 * zero, because "we don't do that here" and "we did none today" are different
 * facts.
 *
 * Scoped with groupScopeFor rather than productScopeFor: these read the SALES
 * ledger, and a store keeps its own books whether or not it shares a product
 * file. Only the department cut leans on shared naming, and it says so.
 */
export default async function MultiStoreMixPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; period?: string; from?: string; to?: string }>
}) {
  const { site, user, capabilities } = await requireSiteUser()
  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'reports.view')) redirect('/not-allowed')
  if (user.controlUserId === null) redirect('/not-allowed')

  const scope = await groupScopeFor(site.id, user.controlUserId, 'reports.view')

  if (!scope || scope.sites.length === 0) {
    return (
      <>
        <PageHeader title="Sales mix by store" subtitle="What sells, how it is paid, and when" />
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
  const view = params.view === 'tenders' || params.view === 'hours' ? params.view : 'departments'
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

  const href = hrefBuilder('/reports/multi-store-mix', params)

  // Only the chosen cut is read — three fan-outs to render one is three times
  // the database work for two tabs nobody is looking at.
  const report: KeyedReport =
    view === 'tenders'
      ? await tendersByStore(scope.sites, range)
      : view === 'hours'
        ? await hoursByStore(scope.sites, range)
        : await departmentsByStore(scope.sites, range)

  const meta = VIEWS[view]
  const rows: StoreRow[] = report.lines.map((line) => ({
    key: line.key,
    label: <span className="text-ink-2">{line.label}</span>,
    values: line.perSite,
    total: line.total,
  }))

  const biggest = report.lines[0]
  // Hours are already in clock order, so "the top one" is a different question.
  const peak =
    view === 'hours'
      ? [...report.lines].sort((a, b) => b.total - a.total)[0]
      : biggest

  return (
    <>
      <PageHeader
        title="Sales mix by store"
        subtitle={`${scope.group.name} — ${range.from} to ${range.to}`}
      />
      <PageBody>
        <LinkTabs
          items={[
            { value: 'departments', label: 'By department', href: href({ view: 'departments' }) },
            { value: 'tenders', label: 'By tender', href: href({ view: 'tenders' }) },
            { value: 'hours', label: 'By hour', href: href({ view: 'hours' }) },
          ]}
          value={view}
          aria-label="Cut"
        />

        <LinkTabs
          items={Object.entries(presets).map(([key, p]) => ({
            value: key,
            label: p.label,
            href: href({ period: key, from: null, to: null }),
          }))}
          value={params.from ? 'custom' : preset}
          aria-label="Period"
        />

        <StatStrip columns={3}>
          <StatTile
            label="Group turnover"
            value={formatMoney(report.total)}
            hint={`${report.lines.length} ${meta.noun}`}
            icon={<Icons.Coins size={20} />}
            iconTone="success"
          />
          <StatTile
            label={meta.topLabel}
            value={peak?.label ?? '—'}
            hint={
              peak && report.total > 0
                ? `${formatMoney(peak.total)} · ${Math.round((peak.total / report.total) * 100)}% of turnover`
                : undefined
            }
            icon={meta.icon}
          />
          <StatTile
            label="Stores compared"
            value={String(report.sites.length)}
            hint={report.failures.length > 0 ? `${report.failures.length} could not be read` : 'All reporting'}
            tone={report.failures.length > 0 ? 'warning' : 'default'}
            icon={<Icons.Store size={20} />}
          />
        </StatStrip>

        {report.failures.length > 0 && (
          <Card>
            <CardBody>
              <p className="text-sm">
                <Badge tone="warning">Some stores could not be read</Badge>
                <span className="ml-2 text-muted">
                  {report.failures.map((f) => `${f.name}: ${f.error}`).join('; ')} — left out rather
                  than counted as zero.
                </span>
              </p>
            </CardBody>
          </Card>
        )}

        {report.lines.length === 0 ? (
          <Card>
            <CardBody>
              <EmptyState
                title="Nothing sold in this period"
                hint="Choose a different period, or check that the linked stores have finalised sales in this range."
              />
            </CardBody>
          </Card>
        ) : (
          <>
            {/* Share of the group, which the table's own columns cannot show. */}
            {report.total > 0 && (
              <Card>
                <CardHeader title={meta.shareTitle} description={meta.shareHint} />
                <CardBody>
                  <div className="flex flex-col gap-3">
                    {report.lines.slice(0, 12).map((line) => (
                      <div key={line.key} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="min-w-0 truncate text-ink-2">{line.label}</span>
                          <span className="numeric shrink-0 text-muted">
                            {formatMoney(line.total)}
                            <span className="ml-2 text-faint">
                              {Math.round((line.total / report.total) * 100)}%
                            </span>
                          </span>
                        </div>
                        <MeterBar
                          segments={[
                            {
                              label: line.label,
                              value: Math.max(line.total, 0),
                              tone: line.key === peak?.key ? 'success' : 'brand',
                            },
                          ]}
                          total={report.total}
                        />
                      </div>
                    ))}
                  </div>
                  {report.lines.length > 12 && (
                    <p className="mt-3 text-xs text-muted">
                      {/* Hours are in CLOCK order, so the first twelve are the
                          earliest, not the biggest — saying "largest" there
                          would be a plain lie about what is on screen. */}
                      {view === 'hours'
                        ? `Showing the first 12 hours of ${report.lines.length}. Every one is in the table below.`
                        : `Showing the 12 largest of ${report.lines.length}. Every one is in the table below.`}
                    </p>
                  )}
                </CardBody>
              </Card>
            )}

            <Card>
              <CardHeader title={meta.tableTitle} description={meta.tableHint} />
              <StoreColumnTable
                columns={report.sites.map((s) => ({ siteId: s.siteId, name: s.name }))}
                rows={rows}
                format={formatMoney}
                firstHeading={meta.firstHeading}
                emptyNote={meta.dashNote}
              />
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}

/** What each cut is called, and what its dash means — the only thing that differs. */
const VIEWS = {
  departments: {
    noun: 'departments',
    topLabel: 'Biggest department',
    icon: <Icons.LayoutGrid size={20} />,
    shareTitle: 'Share of group turnover',
    shareHint: 'Which parts of the business are earning, across every store.',
    tableTitle: 'By department and store',
    tableHint:
      'Matched by department name, which is what stores keep in step. VAT inclusive, finalised sales only.',
    firstHeading: 'Department',
    dashNote:
      'A dash means that store does not run the department at all — which is a different thing from running it and selling nothing.',
  },
  tenders: {
    noun: 'tender types',
    topLabel: 'Most used tender',
    icon: <Icons.CreditCard size={20} />,
    shareTitle: 'How the group gets paid',
    shareHint: 'A store drifting towards cash is worth a look; it also drives banking and card fees.',
    tableTitle: 'By tender and store',
    tableHint:
      'Matched by tender code, the stable handle a rename cannot break. Net of change given, so a R100 note on an R87.50 sale counts as R87.50.',
    firstHeading: 'Tender',
    dashNote: 'A dash means that store does not accept the tender at all.',
  },
  hours: {
    noun: 'trading hours',
    topLabel: 'Busiest hour',
    icon: <Icons.Clock size={20} />,
    shareTitle: 'When the group trades',
    shareHint: 'Two shops in one town often have genuinely different rushes, and rosters assume they do not.',
    tableTitle: 'By hour and store',
    tableHint: 'Taken from when each sale was rung up, in clock order.',
    firstHeading: 'Hour',
    dashNote: 'A dash means that store rang up nothing in that hour.',
  },
} as const
