import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { listQuotes, quoteSummary, lostReasons, QUOTE_STATE_LABELS } from '@/lib/site/quotes'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  EmptyState,
  Badge,
  Icons,
  LinkTabs,
  SearchBar,
  Pagination,
  DataTable,
  type Column,
} from '@/components/ui'
import { NewQuoteButton } from './NewQuoteButton'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

type QuoteRow = Awaited<ReturnType<typeof listQuotes>>['items'][number]

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

  const columns: Column<QuoteRow>[] = [
    {
      key: 'number',
      header: 'Number',
      cell: (q) => (
        <Link href={`/sales/quotes/${q.id}`} className="block hover:text-brand">
          <span className="text-ink">{q.documentNumber ?? `Draft #${q.id}`}</span>
          <span className="mt-0.5 block text-xs text-muted">{q.documentDate}</span>
        </Link>
      ),
      sortValue: (q) => q.documentNumber ?? '',
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (q) => <span className="text-ink">{q.customerName ?? 'Not stated'}</span>,
      sortValue: (q) => q.customerName ?? '',
    },
    {
      key: 'state',
      header: 'State',
      cell: (q) => (
        <Badge
          tone={
            q.state === 'accepted'
              ? 'success'
              : q.state === 'expired'
                ? 'danger'
                : q.state === 'declined' || q.state === 'cancelled'
                  ? 'default'
                  : 'warning'
          }
        >
          {QUOTE_STATE_LABELS[q.state]}
        </Badge>
      ),
      sortValue: (q) => q.state,
    },
    {
      key: 'valid',
      header: 'Valid until',
      cell: (q) =>
        q.validUntil === null ? (
          <span className="text-faint">No expiry</span>
        ) : (
          <>
            <span className={q.state === 'expired' ? 'text-danger' : 'text-ink-2'}>
              {q.validUntil}
            </span>
            {/* Days left only where it is actionable — a quote expiring in a
                week is a phone call; one expiring in three months is not. */}
            {q.state === 'open' && q.daysRemaining !== null && q.daysRemaining <= 7 && (
              <span className="mt-0.5 block text-xs text-warning-ink">
                {q.daysRemaining <= 0
                  ? 'expires today'
                  : `${q.daysRemaining} day${q.daysRemaining === 1 ? '' : 's'} left`}
              </span>
            )}
          </>
        ),
      sortValue: (q) => q.validUntil ?? '',
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      cell: (q) => <span className="text-ink">{formatMoney(q.totalIncl)}</span>,
      sortValue: (q) => q.totalIncl,
    },
  ]

  return (
    <>
      <PageHeader
        title="Quotes"
        subtitle={`${summary.openCount} awaiting a decision`}
        action={<NewQuoteButton />}
      />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Out for decision"
            value={formatMoney(summary.openValue)}
            hint={`${summary.openCount} quote${summary.openCount === 1 ? '' : 's'}`}
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
          />
          <StatTile
            label="Expired"
            value={formatMoney(summary.expiredValue)}
            tone={summary.expiredCount > 0 ? 'danger' : 'default'}
            hint={`${summary.expiredCount} never answered`}
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
          />
        </div>

        <Card>
          <CardHeader
            title="Quotes"
            description="A quote reserves no stock and posts nothing — it is an offer until it is accepted."
            action={<SearchBar
                action="/sales/quotes"
                defaultValue={params.q}
                placeholder="Number, customer or reference…"
                keep={{ state: params.state }}
              />}
          />

          <LinkTabs
            items={[
              { value: 'all', label: 'All', href: href({ state: null, page: null }) },
              { value: 'open', label: `Open${summary.openCount ? ` (${summary.openCount})` : ''}`, href: href({ state: 'open', page: null }) },
              { value: 'expired', label: 'Expired', href: href({ state: 'expired', page: null }) },
              { value: 'accepted', label: 'Accepted', href: href({ state: 'accepted', page: null }) },
              { value: 'declined', label: 'Lost', href: href({ state: 'declined', page: null }) },
              { value: 'draft', label: 'Drafts', href: href({ state: 'draft', page: null }) },
            ]}
            value={state ?? 'all'}
            aria-label="Quote state"
          />

          {items.length === 0 ? (
            <CardBody>
              <EmptyState
                title={params.q ? `Nothing matches "${params.q}"` : 'No quotes yet'}
                hint={
                  params.q
                    ? 'Try a different search.'
                    : 'A quote is priced and captured exactly like an invoice — it just does not post until the customer accepts it.'
                }
                action={!params.q ? <NewQuoteButton /> : undefined}
              />
            </CardBody>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={items}
                getRowKey={(q) => q.id}
                empty={{ title: 'No quotes', hint: 'Nothing in this filter.' }}
              />
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
