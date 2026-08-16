import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { groupScopeFor, likeForLike, type LfeExclusion } from '@/lib/groupReporting'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
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
 * Like-for-like — growth with new stores taken out of it.
 *
 * The measure a chain is actually judged on, and the one a plain turnover total
 * cannot give: opening a shop lifts group turnover by construction, so "up 22%"
 * may be four stores trading worse and a fifth one new. This answers the
 * question underneath — did the shops we had last year sell more this year.
 *
 * The headline counts only stores that traded in BOTH windows. Everything else
 * is listed under it with a reason, because an exclusion nobody can see is
 * indistinguishable from a bug.
 */
export default async function MultiStoreLikeForLikePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; period?: string }>
}) {
  const { site, user, capabilities } = await requireSiteUser()
  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'reports.view')) redirect('/not-allowed')
  if (user.controlUserId === null) redirect('/not-allowed')

  const scope = await groupScopeFor(site.id, user.controlUserId, 'reports.view')

  if (!scope || scope.sites.length === 0) {
    return (
      <>
        <PageHeader title="Like-for-like sales" subtitle="Growth with new stores taken out" />
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
  const preset = params.period ?? 'ytd'
  const presets: Record<string, { from: string; to: string; label: string }> = {
    mtd: { from: `${now.slice(0, 7)}-01`, to: now, label: 'This month' },
    ytd: { from: `${now.slice(0, 4)}-01-01`, to: now, label: 'This year' },
    full: { from: `${Number(now.slice(0, 4)) - 1}-01-01`, to: `${Number(now.slice(0, 4)) - 1}-12-31`, label: 'Last full year' },
  }
  const chosen = presets[preset] ?? presets.ytd
  const range = {
    from: /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '') ? params.from! : chosen.from,
    to: /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '') ? params.to! : chosen.to,
  }

  const href = hrefBuilder('/reports/multi-store-like-for-like', params)
  const lfl = await likeForLike(scope.sites, range)

  const excludedStores = lfl.stores.filter((s) => !s.comparable)
  const comparableCount = lfl.stores.length - excludedStores.length
  const change = lfl.comparableChangePct

  return (
    <>
      <PageHeader
        title="Like-for-like sales"
        subtitle={`${scope.group.name} — ${range.from} to ${range.to} against ${lfl.prior.from} to ${lfl.prior.to}`}
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
            label="Like-for-like"
            value={change === null ? '—' : `${change > 0 ? '+' : ''}${change}%`}
            hint={comparableCount === 0 ? 'No comparable stores' : `${comparableCount} comparable ${comparableCount === 1 ? 'store' : 'stores'}`}
            tone={change === null ? 'default' : change < 0 ? 'danger' : 'positive'}
            icon={<Icons.BarChart size={20} />}
          />
          <StatTile
            label="Comparable stores now"
            value={formatMoney(lfl.comparableCurrent)}
            hint="Stores trading in both periods"
            icon={<Icons.Coins size={20} />}
            iconTone="success"
          />
          <StatTile
            label="Same stores, last year"
            value={formatMoney(lfl.comparablePrior)}
            hint={`${lfl.prior.from} to ${lfl.prior.to}`}
            icon={<Icons.History size={20} />}
          />
          <StatTile
            label="Group total now"
            value={formatMoney(lfl.totalCurrent)}
            hint={
              excludedStores.length > 0
                ? `Includes ${excludedStores.length} non-comparable`
                : 'Every store is comparable'
            }
            icon={<Icons.Store size={20} />}
          />
        </StatStrip>

        {/* The sentence the whole screen exists to let somebody say. */}
        {change !== null && excludedStores.length > 0 && (
          <Card>
            <CardBody>
              <p className="text-sm text-ink-2">
                The {comparableCount} {comparableCount === 1 ? 'store' : 'stores'} trading in both
                periods {change >= 0 ? 'grew' : 'fell'}{' '}
                <span className={change >= 0 ? 'font-semibold text-success' : 'font-semibold text-danger'}>
                  {Math.abs(change)}%
                </span>
                . Group turnover of {formatMoney(lfl.totalCurrent)} also includes{' '}
                {excludedStores.length} store{excludedStores.length === 1 ? '' : 's'} that cannot be
                compared, so the group figure and this one answer different questions.
              </p>
            </CardBody>
          </Card>
        )}

        {lfl.failures.length > 0 && (
          <Card>
            <CardBody>
              <p className="text-sm">
                <Badge tone="warning">Some stores could not be read</Badge>
                <span className="ml-2 text-muted">
                  {lfl.failures.map((f) => `${f.name}: ${f.error}`).join('; ')} — left out rather
                  than counted as zero.
                </span>
              </p>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
              tone="default"
            title="By store"
            description="Finalised invoices and credit sales, VAT inclusive. The prior window is the same calendar dates one year earlier."
          />
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Store</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>This period</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Last year</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Change</th>
                  <th className={TABLE_TH}>In the figure</th>
                </tr>
              </thead>
              <tbody>
                {lfl.stores.map((s) => (
                  <tr key={s.siteId} className={TABLE_ROW}>
                    <td className={`${TABLE_TD} font-medium text-ink`}>{s.name}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(s.current)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {s.excluded === 'not-trading-then' ? (
                        <span className="text-faint" title="Not trading in the prior period">—</span>
                      ) : (
                        formatMoney(s.prior)
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {s.changePct === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <span className={s.changePct >= 0 ? 'text-success' : 'text-danger'}>
                          {s.changePct >= 0 ? '▲' : '▼'} {Math.abs(s.changePct)}%
                        </span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      {s.comparable ? (
                        <Badge tone="success">Counted</Badge>
                      ) : (
                        <>
                          <Badge tone="neutral">Excluded</Badge>
                          <span className="ml-2 text-xs text-muted">{REASONS[s.excluded!]}</span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className={TABLE_TOTAL_ROW}>
                  <td className={`${TABLE_TD} font-semibold`}>Comparable stores</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                    {formatMoney(lfl.comparableCurrent)}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                    {formatMoney(lfl.comparablePrior)}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                    {change === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span className={change >= 0 ? 'text-success' : 'text-danger'}>
                        {change >= 0 ? '▲' : '▼'} {Math.abs(change)}%
                      </span>
                    )}
                  </td>
                  <td className={TABLE_TD} />
                </tr>
              </tbody>
            </table>
          </div>
          <CardBody>
            <p className="text-xs text-muted">
              A store counts only when it recorded sales in both periods. One that opened or closed
              during the year would otherwise make the comparison say more about the shape of the
              group than about how the shops traded.
            </p>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}

const REASONS: Record<LfeExclusion, string> = {
  'not-trading-then': 'No sales a year ago',
  'not-trading-now': 'No sales this period',
  unreadable: 'Could not be read',
}
