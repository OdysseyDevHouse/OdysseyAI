import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { has } from '@/lib/control/modules'
import {
  groupScopeFor,
  groupDashboard,
  monthToDateWindows,
  percentChange,
  marginPct,
  storeExceptions,
  type ExcludedSite,
  type GroupDashboardRow,
  type SiteResult,
} from '@/lib/groupReporting'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import {
  PageHeader,
  PageBody,
  Card,
  CardBody,
  CardHeader,
  StatStrip,
  StatTile,
  EmptyState,
  Badge,
  ButtonLink,
  Icons,
  MeterBar,
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
 * The multi-store dashboard — which store needs attention today.
 *
 * Lives under /reports because that is where somebody goes looking for a figure
 * covering more than one store; "Group" was a menu section of its own, naming a
 * word the shops themselves do not use. The underlying link between stores is
 * still a GROUP in the control database (`groupReporting.ts`, Setup → Linked
 * stores) — only what a user reads and types has changed.
 *
 * It leads with EXCEPTIONS rather than a grid of figures. A chain owner opens
 * this screen to find out where to spend the morning, and a table of correct
 * numbers makes them work that out for themselves every single day. Every
 * headline also carries its change against the same days of last month: a
 * figure with nothing to compare it to cannot be acted on.
 *
 * A store appears only when THIS user may open it and their role there grants
 * the dashboard; anything else is listed under the table with its reason.
 * A store whose database cannot be read renders an error chip in its row —
 * one broken store must never blank the other four.
 */
/**
 * Why a store is missing from the totals.
 *
 * A lookup rather than a ternary: there are three reasons now, and each sends
 * the reader somewhere different — two to store access, one to the bill.
 */
const EXCLUSION_REASONS: Record<ExcludedSite['reason'], string> = {
  'no-access': 'you do not have access to this store',
  'no-permission': 'your role at this store does not include the dashboard',
  'no-module': 'this store’s plan does not include Multi-Branch',
}

export default async function MultiStoreOverviewPage() {
  const { site, user, capabilities, modules } = await requireSiteUser()
  /* Module before capability: "your shop has not bought Multi-Branch" and
     "your role does not include this" are fixed by different people. */
  if (!has(modules, 'multi_branch')) redirect('/upgrade?module=multi_branch')

  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'dashboard.view')) redirect('/not-allowed')
  if (user.controlUserId === null) redirect('/not-allowed')

  const scope = await groupScopeFor(site.id, user.controlUserId, 'dashboard.view')

  if (!scope || scope.sites.length === 0) {
    return (
      <>
        <PageHeader title="Multi-store overview" subtitle="Every linked store, side by side" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title="This store is not linked to any others"
                hint="Link stores together to see their trading side by side. Linking lives under Setup."
                action={<ButtonLink href="/setup/linked-stores" variant="secondary">Open linked stores</ButtonLink>}
              />
            </CardBody>
          </Card>
        </PageBody>
      </>
    )
  }

  const now = today()
  const window = monthToDateWindows(now)
  const rows = await groupDashboard(scope.sites, { todayIso: now, ...window })

  const showGp = can(capabilities, 'products.cost')
  const okRows = rows.filter((r): r is SiteResult<GroupDashboardRow> & { ok: true } => r.ok)
  const sum = (pick: (d: GroupDashboardRow) => number) =>
    okRows.reduce((t, r) => t + pick(r.data), 0)

  const todayTotal = sum((d) => d.today.turnoverIncl)
  const monthTotal = sum((d) => d.month.turnoverIncl)
  const prevTotal = sum((d) => d.previous.turnoverIncl)
  const gpTotal = sum((d) => d.month.grossProfit)
  const gpPrev = sum((d) => d.previous.grossProfit)
  const exclTotal = sum((d) => d.month.turnoverExcl)
  const exclPrev = sum((d) => d.previous.turnoverExcl)
  const stockTotal = sum((d) => d.stockValue)

  const salesChange = percentChange(monthTotal, prevTotal)
  const groupMargin = marginPct(gpTotal, exclTotal)
  const priorMargin = marginPct(gpPrev, exclPrev)
  const marginShift =
    groupMargin !== null && priorMargin !== null ? Math.round((groupMargin - priorMargin) * 10) / 10 : null

  const exceptions = storeExceptions(rows)

  // Ranked by what each store contributed this month, biggest first — the
  // question "who is carrying the group" is not answerable from a list in
  // group-configuration order.
  const ranked = [...okRows].sort((a, b) => b.data.month.turnoverIncl - a.data.month.turnoverIncl)
  const best = ranked[0]

  return (
    <>
      <PageHeader
        title="Multi-store overview"
        subtitle={`${scope.group.name} — month to date, against the same days of last month`}
      />
      <PageBody>
        <StatStrip>
          <StatTile
            label="Turnover, all stores"
            value={formatMoney(monthTotal)}
            hint={changeHint(salesChange, 'on last month')}
            tone={salesChange !== null && salesChange < 0 ? 'warning' : 'default'}
            icon={<Icons.Coins size={20} />}
            iconTone="success"
          />
          {showGp ? (
            <StatTile
              label="Gross profit"
              value={groupMargin === null ? formatMoney(gpTotal) : `${groupMargin}%`}
              hint={
                marginShift === null
                  ? formatMoney(gpTotal)
                  : `${formatMoney(gpTotal)} · ${signed(marginShift)} pts`
              }
              tone={marginShift !== null && marginShift < 0 ? 'warning' : 'default'}
              icon={<Icons.BarChart size={20} />}
            />
          ) : (
            <StatTile
              label="Stores trading"
              value={String(okRows.length)}
              hint={`of ${scope.sites.length} linked`}
              icon={<Icons.Store size={20} />}
            />
          )}
          <StatTile
            label="Taken today"
            value={formatMoney(todayTotal)}
            hint={`${sum((d) => d.today.saleCount)} sales`}
            icon={<Icons.Receipt size={20} />}
          />
          <StatTile
            label="Needs attention"
            value={String(exceptions.length)}
            hint={exceptions.length === 0 ? 'Nothing flagged' : summarise(exceptions)}
            tone={exceptions.length > 0 ? 'warning' : 'default'}
            icon={<Icons.StatusWarning size={20} />}
            iconTone={exceptions.length > 0 ? 'warning' : 'default'}
          />
        </StatStrip>

        {/* ── What to look at, before any grid of figures ─────────────────── */}
        {exceptions.length > 0 && (
          <Card>
            <CardHeader
              tone="default"
              title="Needs attention"
              description="Thresholds: gross profit down 2 points, drawer out by R500, turnover down 10%, or over 6 months of stock."
            />
            <CardBody>
              <ul className="flex flex-col gap-2">
                {exceptions.map((e, i) => (
                  <li key={`${e.siteId}-${e.kind}-${i}`} className="flex items-start gap-3">
                    <span className="mt-0.5 shrink-0">
                      <Badge tone={e.kind === 'unreadable' ? 'danger' : 'warning'}>
                        {LABELS[e.kind]}
                      </Badge>
                    </span>
                    <span className="min-w-0 text-sm">
                      <span className="font-medium text-ink">{e.name}</span>
                      <span className="text-muted"> — {e.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {/* ── Contribution, ranked ─────────────────────────────────────────── */}
        {ranked.length > 1 && monthTotal > 0 && (
          <Card>
            <CardHeader
              tone="default"
              title="Who is carrying the month"
              description="Share of group turnover, biggest first."
            />
            <CardBody>
              <div className="flex flex-col gap-3">
                {ranked.map((r) => (
                  <div key={r.siteId} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-ink-2">{r.name}</span>
                      <span className="numeric shrink-0 text-muted">
                        {formatMoney(r.data.month.turnoverIncl)}
                        <span className="ml-2 text-faint">
                          {Math.round((r.data.month.turnoverIncl / monthTotal) * 100)}%
                        </span>
                      </span>
                    </div>
                    <MeterBar
                      segments={[
                        {
                          label: r.name,
                          value: Math.max(r.data.month.turnoverIncl, 0),
                          tone: r.siteId === best?.siteId ? 'success' : 'brand',
                        },
                      ]}
                      total={monthTotal}
                    />
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        )}

        {/* ── The detail ───────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
              tone="default"
            title="By store"
            description={`Today is ${now}. The month runs ${window.monthFrom} to ${window.monthTo}, compared against ${window.prevFrom} to ${window.prevTo}. Figures come from each store's own records.`}
          />
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Store</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Today</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Month</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>vs last</th>
                  {showGp && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>GP %</th>}
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Drawer</th>
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
                      <StoreCells data={row.data} showGp={showGp} />
                    ) : (
                      <td className={TABLE_TD} colSpan={showGp ? 6 : 5}>
                        <Badge tone="warning">Could not read this store</Badge>
                        <span className="ml-2 text-xs text-muted">{row.error}</span>
                      </td>
                    )}
                  </tr>
                ))}
                <tr className={TABLE_TOTAL_ROW}>
                  <td className={`${TABLE_TD} font-semibold`}>All stores</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>{formatMoney(todayTotal)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>{formatMoney(monthTotal)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                    <Change pct={salesChange} />
                  </td>
                  {showGp && (
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                      {groupMargin === null ? <span className="text-faint">—</span> : `${groupMargin}%`}
                    </td>
                  )}
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                    {formatMoney(sum((d) => d.cashVariance))}
                  </td>
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
                  .map((e) => `${e.name} (${EXCLUSION_REASONS[e.reason]})`)
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

/** The numeric half of a store's row, so the failure case stays readable above. */
function StoreCells({ data, showGp }: { data: GroupDashboardRow; showGp: boolean }) {
  const change = percentChange(data.month.turnoverIncl, data.previous.turnoverIncl)
  const margin = marginPct(data.month.grossProfit, data.month.turnoverExcl)
  // Only a SHORT drawer is an exception; over is noted but not alarming.
  const short = data.cashVariance < 0

  return (
    <>
      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(data.today.turnoverIncl)}</td>
      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(data.month.turnoverIncl)}</td>
      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
        <Change pct={change} />
      </td>
      {showGp && (
        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
          {margin === null ? <span className="text-faint">—</span> : `${margin}%`}
        </td>
      )}
      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
        {data.cashVariance === 0 ? (
          <span className="text-faint">—</span>
        ) : (
          <span className={short ? 'text-danger' : 'text-muted'}>{formatMoney(data.cashVariance)}</span>
        )}
      </td>
      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(data.stockValue)}</td>
    </>
  )
}

/**
 * A period-on-period change.
 *
 * A dash, not a zero, when there is no prior period to compare against — a
 * store that opened this month has not grown by 0%.
 */
function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-faint">—</span>
  if (pct === 0) return <span className="text-muted">0%</span>
  const up = pct > 0
  return (
    <span className={up ? 'text-success' : 'text-danger'}>
      {up ? '▲' : '▼'} {Math.abs(pct)}%
    </span>
  )
}

const LABELS: Record<string, string> = {
  unreadable: 'Unreadable',
  'cash-short': 'Cash',
  'margin-drop': 'Margin',
  'sales-drop': 'Sales',
  'stock-cover': 'Stock',
}

/** "2 margin, 1 cash" — enough to know what kind of morning it is. */
function summarise(exceptions: { kind: string }[]): string {
  const counts = new Map<string, number>()
  for (const e of exceptions) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
  return [...counts.entries()]
    .map(([kind, n]) => `${n} ${LABELS[kind].toLowerCase()}`)
    .join(' · ')
}

function changeHint(pct: number | null, suffix: string): string {
  if (pct === null) return 'No prior period to compare'
  if (pct === 0) return `Level ${suffix}`
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% ${suffix}`
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}
