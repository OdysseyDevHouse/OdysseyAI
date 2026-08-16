import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { productScopeFor, groupStockByCode, rebalanceSuggestions } from '@/lib/groupReporting'
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
  SearchBar,
  Icons,
  StoreColumnTable,
  type StoreRow,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * Stock across every linked store, and where it should move.
 *
 * ── WHY THIS SCREEN SCOPES DIFFERENTLY FROM THE OTHERS ────────────────────
 *
 * Every other cross-store report uses `groupScopeFor`, which is group
 * MEMBERSHIP. This one uses `productScopeFor`, which is narrower: only stores
 * that actually SHARE A PRODUCT FILE. Product identity across databases is the
 * stock code, and a code only means the same thing in two stores that share
 * their products — otherwise "A-1042" is coffee in one shop and a brake pad in
 * another, and summing them produces a number that is silently meaningless.
 *
 * The rebalancing rule is deliberately conservative: a store only offers what it
 * holds ABOVE its own reorder level, so a suggested transfer can never create a
 * second shortage to fix the first. Suggestions are advice — moving the stock is
 * a store transfer somebody chooses to raise.
 */
export default async function MultiStoreStockPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string }>
}) {
  const { site, user, capabilities } = await requireSiteUser()
  // A hidden menu entry is not a boundary — this URL is typeable.
  if (!can(capabilities, 'products.view')) redirect('/not-allowed')
  if (user.controlUserId === null) redirect('/not-allowed')

  const scope = await productScopeFor(site.id, user.controlUserId, 'products.view')

  if (!scope || scope.sites.length < 2) {
    return (
      <>
        <PageHeader title="Stock across stores" subtitle="What every linked store holds" />
        <PageBody>
          <Card>
            <CardBody>
              <EmptyState
                title="No stores share a product file with this one"
                hint="Stock is matched across stores by product code, so this needs at least two stores with product sharing switched on. That lives under Setup → Linked stores."
                action={<ButtonLink href="/setup/linked-stores" variant="secondary">Open linked stores</ButtonLink>}
              />
            </CardBody>
          </Card>
        </PageBody>
      </>
    )
  }

  const params = await searchParams
  const view = params.view === 'all' ? 'all' : 'rebalance'
  const search = params.q?.trim() || undefined
  const href = hrefBuilder('/reports/multi-store-stock', params)

  const stock = await groupStockByCode(scope.sites, {
    onlyProblems: view === 'rebalance',
    search,
  })
  const suggestions = view === 'rebalance' ? rebalanceSuggestions(stock) : []

  const movable = suggestions.reduce((t, s) => t + s.qty, 0)
  const shortLines = stock.lines.filter((l) => l.shortCount > 0).length

  /* How many stores have set ANY reorder level. A store with none can never
     register as short or as surplus, which is the usual reason a rebalancing
     report comes back empty — and the reason it must be said out loud rather
     than left as "nothing to move". */
  const storesWithLevels = stock.sites.filter((_, i) =>
    stock.lines.some((l) => l.perSite[i]?.minStock > 0),
  ).length

  /* The detail table is context for the suggestions, not the report. On a
     40,000-line product file every store is short of something, and 400 rows
     of it buries the handful of moves that are the actual answer. The full
     list is one click away on the All stock tab, and search reaches any line. */
  const DETAIL_CAP = 25
  const detailLines =
    view === 'rebalance' && !search ? stock.lines.slice(0, DETAIL_CAP) : stock.lines
  const detailTrimmed = detailLines.length < stock.lines.length

  const rows: StoreRow[] = detailLines.map((line) => ({
    key: line.code,
    label: (
      <span className="flex flex-col">
        <span className="font-medium text-ink">{line.description || line.code}</span>
        <span className="text-xs text-muted">{line.code}</span>
      </span>
    ),
    values: line.perSite.map((c) => c.onHand),
    total: line.totalOnHand,
  }))

  return (
    <>
      <PageHeader
        title="Stock across stores"
        subtitle={`${scope.group.name} — matched by product code`}
      />
      <PageBody>
        <LinkTabs
          items={[
            { value: 'rebalance', label: 'Needs rebalancing', href: href({ view: 'rebalance' }) },
            { value: 'all', label: 'All stock', href: href({ view: 'all' }) },
          ]}
          value={view}
          aria-label="View"
        />

        <StatStrip columns={4}>
          <StatTile
            label="Moves suggested"
            value={String(suggestions.length)}
            hint={view === 'all' ? 'Switch to rebalancing' : `${movable} units in total`}
            tone={suggestions.length > 0 ? 'warning' : 'default'}
            icon={<Icons.ArrowLeftRight size={20} />}
            iconTone={suggestions.length > 0 ? 'warning' : 'default'}
          />
          <StatTile
            label="Lines short somewhere"
            value={String(shortLines)}
            hint="Below reorder level at one or more stores"
            icon={<Icons.StatusWarning size={20} />}
          />
          <StatTile
            label="Stores compared"
            value={String(stock.sites.length)}
            hint="Sharing a product file"
            icon={<Icons.Store size={20} />}
          />
          <StatTile
            label="Lines shown"
            value={String(stock.lines.length)}
            hint={stock.truncated ? `Capped — narrow with search` : 'All matching lines'}
            tone={stock.truncated ? 'warning' : 'default'}
            icon={<Icons.Boxes size={20} />}
          />
        </StatStrip>

        {stock.failures.length > 0 && (
          <Card>
            <CardBody>
              <p className="text-sm">
                <Badge tone="warning">Some stores could not be read</Badge>
                <span className="ml-2 text-muted">
                  {stock.failures.map((f) => `${f.name}: ${f.error}`).join('; ')} — left out rather
                  than counted as empty.
                </span>
              </p>
            </CardBody>
          </Card>
        )}

        {/* ── The answer: what to move ──────────────────────────────────────── */}
        {view === 'rebalance' && (
          <Card>
            <CardHeader
              tone="default"
              title="Suggested moves"
              description="A store only offers what it holds above its own reorder level, so a move can never create a second shortage to fix the first."
            />
            {suggestions.length === 0 ? (
              <CardBody>
                <EmptyState
                  title="Nothing to move"
                  hint={
                    /* "Nothing to move" has two very different causes, and a
                       single message for both sends somebody looking for a bug.
                       Stores short but no donors means the OTHER stores have no
                       reorder levels set, so nothing can ever read as surplus. */
                    shortLines > 0 && storesWithLevels < stock.sites.length
                      ? `${shortLines} lines are short, but no other store has reorder levels set — so nothing can register as surplus to send. Set levels under Stock → Reorder levels at the other stores.`
                      : 'No line is short at one store while another holds surplus above its own reorder level. That is the healthy state.'
                  }
                  action={
                    shortLines > 0 && storesWithLevels < stock.sites.length ? (
                      <ButtonLink href={href({ view: 'all' })} variant="secondary">
                        See all stock instead
                      </ButtonLink>
                    ) : undefined
                  }
                />
              </CardBody>
            ) : (
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Product</th>
                      <th className={TABLE_TH}>From</th>
                      <th className={TABLE_TH}>To</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Move</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Short by</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Sender spare</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.map((s, i) => (
                      <tr key={`${s.code}-${s.fromSiteId}-${s.toSiteId}-${i}`} className={TABLE_ROW}>
                        <td className={TABLE_TD}>
                          <span className="font-medium text-ink">{s.description || s.code}</span>
                          <span className="ml-2 text-xs text-muted">{s.code}</span>
                        </td>
                        <td className={TABLE_TD}>{s.fromName}</td>
                        <td className={`${TABLE_TD} font-medium text-ink`}>{s.toName}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold text-ink`}>
                          {s.qty}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-danger`}>{s.shortBy}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-muted`}>{s.senderSpare}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <CardBody>
              <p className="text-xs text-muted">
                Suggestions only — nothing has been moved. Raise a store transfer to act on one.
                Stock already in transit is excluded, so goods on a van are never proposed for a
                second journey.
              </p>
            </CardBody>
          </Card>
        )}

        {/* ── The detail ────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
              tone="default"
            title={view === 'rebalance' ? 'Lines short somewhere' : 'On hand, by store'}
            description={
              detailTrimmed
                ? `Quantities on hand, excluding stock in transit. Showing the first ${detailLines.length} of ${stock.lines.length} — search for a code, or open All stock.`
                : 'Quantities on hand, excluding stock in transit.'
            }
            action={
              detailTrimmed ? (
                <ButtonLink href={href({ view: 'all' })} variant="ghost">
                  All {stock.lines.length}
                </ButtonLink>
              ) : undefined
            }
          />
          <SearchBar
            action="/reports/multi-store-stock"
            defaultValue={search ?? ''}
            placeholder="Search a product code or description…"
            keep={{ view }}
          />
          {stock.lines.length === 0 ? (
            <CardBody>
              <EmptyState
                title={search ? `Nothing matches “${search}”` : 'Nothing to show'}
                hint={
                  search
                    ? 'Try a different code or description, or clear the search.'
                    : 'No product carries stock or a reorder level at these stores.'
                }
                action={
                  search ? (
                    <ButtonLink href={href({ q: null })} variant="secondary">
                      Clear search
                    </ButtonLink>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <StoreColumnTable
              columns={stock.sites.map((s) => ({ siteId: s.siteId, name: s.name }))}
              rows={rows}
              format={(n) => String(round3(n))}
              firstHeading="Product"
              totalHeading="Group"
              emptyNote="A dash means the store does not carry that code at all — which is a different thing from carrying it and having none, shown as 0."
            />
          )}
        </Card>
      </PageBody>
    </>
  )
}

/** Quantities are DECIMAL(12,3); trailing zeros on a whole number read as noise. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
