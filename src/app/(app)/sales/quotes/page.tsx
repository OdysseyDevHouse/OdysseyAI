import { requireCapability } from '@/lib/auth'
import { listQuotes, quoteSummary, lostReasons } from '@/lib/site/quotes'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  ButtonLink,
  Card,
  CardHeader,
  CardBody,
  StatStrip,
  StatTile,
  EmptyState,
  LinkSegmentedControl,
  TableToolbar,
  SearchBar,
  Pagination,
  Icons,
} from '@/components/ui'
import { NewQuoteButton } from './NewQuoteButton'
import { QuotesTable, type QuoteTableRow } from './QuotesTable'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/**
 * The quote register.
 *
 * ── WHAT IT LEADS WITH ───────────────────────────────────────────────────
 *
 * Not the count of quotes — the ones about to expire. An open quote is money
 * that might arrive; an expired one is money that has quietly stopped being
 * possible, and nothing else in the system will mention it. The conversion rate
 * sits beside it because it is the number a business owner wants and rarely
 * has.
 */
export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; state?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.view')
  const params = await searchParams
  const page = pageFrom(params.page)

  const state =
    params.state === 'draft' ||
    params.state === 'open' ||
    params.state === 'expired' ||
    params.state === 'accepted' ||
    params.state === 'declined'
      ? params.state
      : undefined

  const [{ items, total }, summary, lost] = await Promise.all([
    listQuotes(siteId, {
      state,
      search: params.q,
      limit: PAGE_SIZE,
      offset: offsetFor(page, PAGE_SIZE),
    }),
    quoteSummary(siteId),
    lostReasons(siteId),
  ])

  const href = hrefBuilder('/sales/quotes', params)

  // Plain rows; the table that draws them owns its columns. See QuotesTable.
  const rows: QuoteTableRow[] = items.map((q) => ({
    id: q.id,
    documentNumber: q.documentNumber,
    documentDate: q.documentDate,
    customerName: q.customerName,
    state: q.state,
    validUntil: q.validUntil,
    daysRemaining: q.daysRemaining,
    totalIncl: q.totalIncl,
  }))

  return (
    <>
      <PageHeader
        title="Quotes"
        icon={<Icons.FileText size={18} />}
        subtitle={`${summary.openCount} awaiting a decision`}
        action={<NewQuoteButton />}
      />

      <PageBody>
        {/* StatStrip rather than a hand-rolled grid, so this strip keeps the
            same gutters and breakpoints as every other one in the app. */}
        <StatStrip columns={4}>
          <StatTile
            label="Out for decision"
            value={formatMoney(summary.openValue)}
            hint={`${summary.openCount} quote${summary.openCount === 1 ? '' : 's'}`}
            icon={<Icons.FileText size={20} />}
          />
          <StatTile
            label="Expiring this week"
            value={formatMoney(summary.expiringSoonValue)}
            tone={summary.expiringSoon > 0 ? 'warning' : 'default'}
            hint={
              summary.expiringSoon > 0
                ? `${summary.expiringSoon} worth a phone call`
                : 'Nothing expiring soon'
            }
            icon={<Icons.Clock size={20} />}
          />
          <StatTile
            label="Expired"
            value={formatMoney(summary.expiredValue)}
            tone={summary.expiredCount > 0 ? 'danger' : 'default'}
            hint={`${summary.expiredCount} never answered`}
            icon={<Icons.StatusWarning size={20} />}
          />
          {/* The number an owner wants and rarely has. */}
          <StatTile
            label="Conversion rate"
            value={summary.conversionRate === null ? '—' : `${summary.conversionRate}%`}
            tone={
              summary.conversionRate === null
                ? 'default'
                : summary.conversionRate >= 50
                  ? 'positive'
                  : 'default'
            }
            hint={
              summary.conversionRate === null
                ? 'No quotes decided yet'
                : `${summary.acceptedCount} won of ${summary.acceptedCount + summary.declinedCount} decided`
            }
            iconTone="success"
            icon={<Icons.StatusSuccess size={20} />}
          />
        </StatStrip>

        {/* A segmented control, not LinkTabs: these slice ONE list by state,
            which is what the segmented bar means. Tabs say "different sections
            of a record" — the wrong promise, and it read as a second page
            heading stacked under the card's own title. The description that
            title carried moves to the empty state, which is where a first-time
            user actually needs telling what a quote is. */}
        <TableToolbar
          actions={
            <div className="w-80">
              <SearchBar
                action="/sales/quotes"
                defaultValue={params.q}
                placeholder="Number, customer or reference…"
                className="p-0"
                keep={{ state: params.state }}
              />
            </div>
          }
        >
          <LinkSegmentedControl
            aria-label="Quote state"
            value={state ?? 'all'}
            options={[
              {
                value: 'all',
                label: 'All',
                icon: <Icons.LayoutGrid size={15} />,
                href: href({ state: null, page: null }),
              },
              {
                value: 'open',
                label: 'Open',
                count: summary.openCount || undefined,
                icon: <Icons.Clock size={15} />,
                href: href({ state: 'open', page: null }),
              },
              {
                value: 'expired',
                label: 'Expired',
                icon: <Icons.StatusWarning size={15} />,
                href: href({ state: 'expired', page: null }),
              },
              {
                value: 'accepted',
                label: 'Accepted',
                icon: <Icons.StatusSuccess size={15} />,
                href: href({ state: 'accepted', page: null }),
              },
              {
                value: 'declined',
                label: 'Lost',
                icon: <Icons.StatusFailure size={15} />,
                href: href({ state: 'declined', page: null }),
              },
              {
                value: 'draft',
                label: 'Drafts',
                icon: <Icons.List size={15} />,
                href: href({ state: 'draft', page: null }),
              },
            ]}
          />
        </TableToolbar>

        <Card>
          {items.length === 0 ? (
            <CardBody>
              {/* Three different empties, and they want different things said:
                  a missed search echoes the term, a filter offers to clear
                  itself, and a genuinely empty register explains what a quote
                  even is — which is the line the card's description used to
                  carry, now shown to the one person who needs it. */}
              <EmptyState
                icon={
                  params.q ? <Icons.Search size={22} /> : <Icons.FileText size={22} />
                }
                title={
                  params.q
                    ? `Nothing matches “${params.q}”`
                    : state
                      ? 'Nothing in this slice'
                      : 'No quotes yet'
                }
                hint={
                  params.q
                    ? 'Check the number, customer or reference, or clear the search.'
                    : state
                      ? 'No quotes are in this state right now.'
                      : 'A quote reserves no stock and posts nothing — it is an offer until it is accepted, priced and captured exactly like an invoice.'
                }
                action={
                  params.q || state ? (
                    <ButtonLink variant="secondary" href="/sales/quotes">
                      {params.q ? 'Clear the search' : 'Show all quotes'}
                    </ButtonLink>
                  ) : (
                    <NewQuoteButton />
                  )
                }
              />
            </CardBody>
          ) : (
            <>
              <QuotesTable rows={rows} />
              <Pagination
                page={page}
                pageCount={pageCountFor(total, PAGE_SIZE)}
                total={total}
                pageSize={PAGE_SIZE}
                hrefFor={(p) => href({ page: p === 1 ? null : String(p) })}
              />
            </>
          )}
        </Card>

        {/* A pattern in the losses is worth more than any individual one. */}
        {lost.length > 0 && (
          <Card>
            <CardHeader
              title="Why quotes are lost"
              description="Recorded when a quote is marked lost. The pattern is the useful part."
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {lost.map((r) => (
                  <li key={r.reason} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-ink-2">{r.reason}</span>
                    <span className="text-muted">
                      {r.count} quote{r.count === 1 ? '' : 's'} ·{' '}
                      <span className="numeric">{formatMoney(r.value)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </PageBody>
    </>
  )
}
