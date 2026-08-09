import { requireCapability } from '@/lib/auth'
import {
  listOfflineExceptions,
  listQuarantinedSales,
  listStuckClaims,
  offlineExceptionCounts,
  type OfflineException,
} from '@/lib/site/offlineExceptions'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  Callout,
  StatTile,
  StatStrip,
  Pagination,
  Icons,
} from '@/components/ui'
import {
  ExceptionsTable,
  QuarantineTable,
  StuckTable,
  type ExceptionRow,
  type StuckRow,
} from './OfflineTables'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/**
 * What a shop has to look at after trading offline.
 *
 * The sync engine posts every offline sale it possibly can, because a refused sale
 * is not an undone sale — the goods are gone and the cash is in the drawer, so
 * refusing one loses the revenue and the VAT rather than preventing anything. That
 * policy is only honest if the things it waves through are visible afterwards,
 * which is this screen.
 *
 * The order of the three sections is the order of urgency, and it is deliberately
 * not the order of severity-sounding names:
 *
 *   1. QUARANTINED first. Not posted at all, so this is money in a drawer that no
 *      ledger knows about. Every row is someone's problem TODAY.
 *   2. STUCK second. A plumbing failure — a till still retrying, or a payload
 *      nothing will ever accept. Fixable, and until it is fixed the takings are
 *      still outside the books.
 *   3. EXCEPTIONS last, and paginated. These are ON the books and the money is
 *      accounted for; what is in question is whether a price or a discount should
 *      have been given. That is a judgement call, and it can wait for a quiet
 *      moment in a way the first two cannot.
 */
export default async function OfflineSalesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.view')
  const params = await searchParams
  const page = pageFrom(params.page)

  const [counts, quarantined, stuck, exceptions] = await Promise.all([
    offlineExceptionCounts(siteId),
    listQuarantinedSales(siteId),
    listStuckClaims(siteId),
    listOfflineExceptions(siteId, { limit: PAGE_SIZE, offset: offsetFor(page, PAGE_SIZE) }),
  ])

  const href = hrefBuilder('/sales/offline', params)

  /* Dates are formatted here rather than in the client component: a Date crossing
     the boundary serialises, but rendering one with the browser's locale is a
     hydration mismatch waiting to happen. */
  const when = (value: Date | null) =>
    value
      ? new Date(value).toLocaleString('en-ZA', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null

  const toRow = (item: OfflineException): ExceptionRow => ({
    documentId: item.documentId,
    documentNumber: item.documentNumber,
    status: item.status,
    documentDate: item.documentDate,
    takenAtLabel: when(item.takenAt),
    terminalCode: item.terminalCode,
    userName: item.userName,
    customerName: item.customerName,
    totalIncl: item.totalIncl,
    exception: item.exception,
  })

  const stuckRows: StuckRow[] = stuck.map((claim) => ({
    saleUid: claim.saleUid,
    status: claim.status,
    documentNumber: claim.documentNumber,
    operatorName: claim.operatorName,
    error: claim.error,
    attempts: claim.attempts,
    claimedAtLabel: when(claim.claimedAt),
    hasDocument: claim.hasDocument,
  }))

  const allClear = counts.quarantined === 0 && counts.stuck === 0 && counts.exceptions === 0

  return (
    <>
      <PageHeader
        title="Offline sales"
        subtitle="Sales rung up while a till had no connection"
      />

      <PageBody>
        <StatStrip columns={3}>
          {/* The figure that matters most and that a totals row would bury:
              takings that exist in a drawer and in no ledger. */}
          <StatTile
            label="Not on the books"
            value={counts.quarantined > 0 ? formatMoney(counts.quarantinedValue) : formatMoney(0)}
            hint={
              counts.quarantined > 0
                ? `${counts.quarantined} sale${counts.quarantined === 1 ? '' : 's'} quarantined`
                : 'Everything posted'
            }
            tone={counts.quarantined > 0 ? 'danger' : 'default'}
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Still to land"
            value={String(counts.stuck)}
            hint={counts.stuck > 0 ? 'A till is retrying, or something is wrong' : 'Nothing stuck'}
            tone={counts.stuck > 0 ? 'warning' : 'default'}
            icon={<Icons.Syncing size={16} />}
          />
          <StatTile
            label="To review"
            value={String(counts.exceptions)}
            hint={counts.exceptions > 0 ? 'Posted, but something disagreed' : 'Nothing flagged'}
            icon={<Icons.ShieldCheck size={16} />}
          />
        </StatStrip>

        {allClear ? (
          <Callout tone="success" title="Nothing needs attention">
            Every sale rung up offline is on the books, priced as the server would have
            priced it. This screen fills up only when a till trades without a connection
            and something did not line up afterwards.
          </Callout>
        ) : null}

        {/* 1. Quarantined — the urgent list. */}
        {counts.quarantined > 0 ? (
          <Card>
            <CardHeader
              title="Not on the books"
              description="Rung up, paid for, and not posted — the VAT period they fall in is locked"
            />
            <Callout tone="danger" title="This money is not in any ledger">
              These sales were tendered and receipted, so the cash is real. They could not
              post because writing into a locked VAT period would change a figure already
              declared. Reopen the period, or re-date the sale to an open one, and it will
              post with everything intact.
            </Callout>
            <QuarantineTable rows={quarantined.map(toRow)} />
          </Card>
        ) : null}

        {/* 2. Stuck — plumbing. */}
        {counts.stuck > 0 ? (
          <Card>
            <CardHeader
              title="Still to land"
              description="A till claimed these but they have not finished posting"
            />
            <StuckTable rows={stuckRows} />
          </Card>
        ) : null}

        {/* 3. Exceptions — a judgement call, and the only paginated list. */}
        {counts.exceptions > 0 ? (
          <Card>
            <CardHeader
              title="Posted, but worth a look"
              description="On the books and accounted for — what is in question is the price or the person"
            />
            <ExceptionsTable rows={exceptions.items.map(toRow)} />
            <Pagination
              page={page}
              pageCount={pageCountFor(exceptions.total, PAGE_SIZE)}
              total={exceptions.total}
              pageSize={PAGE_SIZE}
              hrefFor={(next) => href({ page: next === 1 ? null : next })}
            />
          </Card>
        ) : null}
      </PageBody>
    </>
  )
}
