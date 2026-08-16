import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { productScopeFor, groupTransfers } from '@/lib/groupReporting'
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
  Callout,
  Icons,
  MeterBar,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * Store transfers seen from above.
 *
 * Each store already reconciles its own transfers, and does it thoroughly — it
 * opens the receiving store's database to ask whether the far end has already
 * taken goods this store still holds. What no screen could show until now is the
 * GROUP: finding a transfer counted twice meant opening each store in turn and
 * knowing to look, which is a check nobody runs.
 *
 * Unsettled drift leads, because it is the only kind that means a figure is
 * wrong: the receiver has the goods and the sender still holds them, so group
 * stock is overstated until the dispatch is settled. A late lorry is shown
 * separately and never turns the page red.
 *
 * Scoped with productScopeFor — transfers only exist between stores that share a
 * product file, since the receiver matches lines by product code.
 */
export default async function MultiStoreTransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>
}) {
  const { site, user, capabilities } = await requireSiteUser()
  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'stock.view')) redirect('/not-allowed')
  if (user.controlUserId === null) redirect('/not-allowed')

  const scope = await productScopeFor(site.id, user.controlUserId, 'stock.view')

  if (!scope || scope.sites.length < 2) {
    return (
      <>
        <PageHeader title="Store transfers" subtitle="What moved between stores, and what got stuck" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title="No stores share a product file with this one"
                hint="Transfers move goods between stores that share products, matched by code. That is switched on under Setup → Linked stores."
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
  const preset = params.period ?? 'quarter'
  const presets: Record<string, { from: string; to: string; label: string }> = {
    month: { from: `${now.slice(0, 7)}-01`, to: now, label: 'This month' },
    quarter: { from: addDays(now, -90), to: now, label: 'Last 90 days' },
    year: { from: `${now.slice(0, 4)}-01-01`, to: now, label: 'This year' },
  }
  const chosen = presets[preset] ?? presets.quarter
  const range = {
    from: /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '') ? params.from! : chosen.from,
    to: /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '') ? params.to! : chosen.to,
  }

  const href = hrefBuilder('/reports/multi-store-transfers', params)
  const report = await groupTransfers(scope.sites, range)

  const unsettled = report.drift.filter((d) => d.kind === 'unsettled')
  const stale = report.drift.filter((d) => d.kind === 'stale')
  const transitUnits = report.inTransit.reduce((t, s) => t + s.units, 0)
  const movedUnits = report.flow.reduce((t, f) => t + f.units, 0)

  return (
    <>
      <PageHeader
        title="Store transfers"
        subtitle={`${scope.group.name} — ${range.from} to ${range.to}`}
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

        <StatStrip columns={4}>
          <StatTile
            label="Counted twice"
            value={String(unsettled.length)}
            hint={unsettled.length === 0 ? 'Nothing to settle' : 'Group stock is overstated'}
            tone={unsettled.length > 0 ? 'danger' : 'default'}
            icon={<Icons.StatusWarning size={20} />}
            iconTone={unsettled.length > 0 ? 'danger' : 'default'}
          />
          <StatTile
            label="Late in transit"
            value={String(stale.length)}
            hint={stale.length === 0 ? 'Nothing overdue' : 'Dispatched over a week ago'}
            tone={stale.length > 0 ? 'warning' : 'default'}
            icon={<Icons.Clock size={20} />}
          />
          <StatTile
            label="On the road now"
            value={String(round3(transitUnits))}
            hint={`${report.inTransit.reduce((t, s) => t + s.transfers, 0)} transfers in transit`}
            icon={<Icons.Truck size={20} />}
          />
          <StatTile
            label="Moved in period"
            value={String(round3(movedUnits))}
            hint={`${report.flow.reduce((t, f) => t + f.transfers, 0)} transfers between stores`}
            icon={<Icons.ArrowLeftRight size={20} />}
          />
        </StatStrip>

        {report.failures.length > 0 && (
          <Card>
            <CardBody>
              <p className="text-sm">
                <Badge tone="warning">Some stores could not be read</Badge>
                <span className="ml-2 text-muted">
                  {report.failures.map((f) => `${f.name}: ${f.error}`).join('; ')} — their transfers
                  are not included, so a problem there would not appear here.
                </span>
              </p>
            </CardBody>
          </Card>
        )}

        {/* ── The one that means a figure is wrong ──────────────────────────── */}
        {unsettled.length > 0 && (
          <Card>
            <CardHeader
              tone="default"
              title="Counted twice"
              description="The receiving store has these goods and the sending store still holds them. Group stock is overstated until each dispatch is settled."
            />
            <CardBody>
              <Callout tone="danger" title="These need settling">
                Open the transfer at the sending store and settle it. The repair is safe to run
                again — it claims the document before it moves anything.
              </Callout>
            </CardBody>
            <TransferTable rows={unsettled} />
          </Card>
        )}

        {stale.length > 0 && (
          <Card>
            <CardHeader
              tone="default"
              title="Late in transit"
              description="Dispatched over a week ago and still not received. Usually a lorry, sometimes a receiver who forgot — not an error, but the goods sit on the sender's books."
            />
            <TransferTable rows={stale} />
          </Card>
        )}

        {report.drift.length === 0 && (
          <Card>
            <CardBody>
              <EmptyState
                title="Every transfer is accounted for"
                hint="Nothing is counted twice, and nothing has been on the road for more than a week."
                icon={<Icons.Check size={28} strokeWidth={1.75} />}
              />
            </CardBody>
          </Card>
        )}

        {/* ── Where stock actually flows ────────────────────────────────────── */}
        <Card>
          <CardHeader
              tone="default"
            title="Where stock flowed"
            description="Counted once, from the sending store. A store that only ever sends is doing warehouse duty for the others."
          />
          {report.flow.length === 0 ? (
            <CardBody>
              <EmptyState
                title="No transfers in this period"
                hint="Nothing moved between these stores in the selected dates."
              />
            </CardBody>
          ) : (
            <CardBody>
              <div className="flex flex-col gap-3">
                {report.flow.map((leg) => (
                  <div key={`${leg.fromSiteId}-${leg.toSiteId}`} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-ink-2">
                        {leg.fromName}
                        <span className="mx-2 text-faint">→</span>
                        {leg.toName}
                      </span>
                      <span className="numeric shrink-0 text-muted">
                        {round3(leg.units)} units
                        <span className="ml-2 text-faint">{leg.transfers} transfers</span>
                      </span>
                    </div>
                    <MeterBar
                      segments={[{ label: `${leg.fromName} to ${leg.toName}`, value: leg.units, tone: 'brand' }]}
                      total={movedUnits}
                    />
                  </div>
                ))}
              </div>
            </CardBody>
          )}
        </Card>

        {report.inTransit.length > 0 && (
          <Card>
            <CardHeader
              tone="default"
              title="On the road now"
              description="Dispatched and not yet received. These sit on the sending store's books, which is correct — but it is capital nobody can sell."
            />
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Sending store</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Transfers</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Units</th>
                  </tr>
                </thead>
                <tbody>
                  {report.inTransit.map((s) => (
                    <tr key={s.siteId} className={TABLE_ROW}>
                      <td className={`${TABLE_TD} font-medium text-ink`}>{s.name}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{s.transfers}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{round3(s.units)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}

/** The drift rows, shared by both tables — only the framing around them differs. */
function TransferTable({
  rows,
}: {
  rows: {
    transferId: number
    siteId: number
    siteName: string
    documentNumber: string | null
    peerSiteName: string | null
    dispatchedAt: Date | null
    totalQty: number
    problem: string
  }[]
}) {
  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            <th className={TABLE_TH}>Document</th>
            <th className={TABLE_TH}>From</th>
            <th className={TABLE_TH}>To</th>
            <th className={TABLE_TH}>Dispatched</th>
            <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Units</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={`${d.siteId}-${d.transferId}`} className={TABLE_ROW}>
              <td className={`${TABLE_TD} font-medium text-ink`}>
                {d.documentNumber ?? `#${d.transferId}`}
              </td>
              <td className={TABLE_TD}>{d.siteName}</td>
              <td className={TABLE_TD}>{d.peerSiteName ?? '—'}</td>
              <td className={TABLE_TD}>{formatDay(d.dispatchedAt)}</td>
              <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{round3(d.totalQty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The dispatch day, as a plain date.
 *
 * getUTC*, never getDate(): the pool runs with timezone 'Z', so a DATETIME comes
 * back as a Date whose wall-clock reading is only correct in UTC. Local getters
 * would shift an evening dispatch to the previous day.
 */
function formatDay(value: Date | null): string {
  if (!value) return '—'
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
