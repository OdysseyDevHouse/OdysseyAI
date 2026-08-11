'use client'

import { useRouter } from 'next/navigation'
import { Badge, DataTable, Icons, type Column } from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import type { StockTransfer, TransferStatus } from '@/lib/site/stockTransfers'

const STATUS_TONE: Record<TransferStatus, 'success' | 'neutral' | 'danger' | 'warning'> = {
  posted: 'success',
  received: 'success',
  // The one state that is waiting on somebody: goods on a truck, on this
  // store's books, and not yet confirmed by the other end.
  in_transit: 'warning',
  draft: 'neutral',
  cancelled: 'danger',
}

const STATUS_LABEL: Record<TransferStatus, string> = {
  posted: 'Posted',
  received: 'Received',
  in_transit: 'In transit',
  draft: 'Draft',
  cancelled: 'Cancelled',
}

/**
 * The transfer list.
 *
 * Six columns, not ten: number, date, route, what moved, who, state. Anything
 * else — the lines, the reference, the void reason — lives on the transfer's
 * own screen, which is one click away. A list is for finding the row, not for
 * reading it.
 */
export default function TransfersTable({ transfers }: { transfers: StockTransfer[] }) {
  const router = useRouter()

  const columns: Column<StockTransfer>[] = [
    {
      key: 'number',
      header: 'Number',
      cell: (t) => <span className="text-ink">{t.documentNumber ?? '—'}</span>,
      sortValue: (t) => t.documentNumber ?? '',
    },
    {
      key: 'date',
      header: 'Date',
      cell: (t) => t.documentDate,
      sortValue: (t) => t.documentDate,
    },
    {
      key: 'route',
      header: 'Moved',
      /*
       * The route IS the transfer — reading it left to right is the fastest way
       * to answer "where did that stock go".
       *
       * A store transfer names the STORE on the far end rather than a location
       * code, because the far end is in another database and its room names
       * mean nothing here. An inbound one has no local source at all, so the
       * left side is the store it came from.
       */
      cell: (t) => {
        const left = t.direction === 'in' ? (t.peerSiteName ?? 'Another store') : t.fromLocationCode
        const right = t.direction === 'out' ? (t.peerSiteName ?? 'Another store') : t.toLocationCode
        return (
          <span className="flex items-center gap-1.5">
            <span className="text-ink-2">{left || '—'}</span>
            <Icons.ArrowLeftRight size={13} className="text-faint" />
            <span className="text-ink">{right || '—'}</span>
          </span>
        )
      },
      sortValue: (t) =>
        `${t.direction === 'in' ? (t.peerSiteName ?? '') : t.fromLocationCode}→${
          t.direction === 'out' ? (t.peerSiteName ?? '') : t.toLocationCode
        }`,
    },
    {
      key: 'kind',
      header: 'Kind',
      // Worth its own column rather than being inferred from the route: a
      // reader scanning for "what did we send to Northgate" should not have to
      // recognise which of the two names is a store.
      cell: (t) => (
        <span className="text-muted">
          {t.direction === 'internal' ? 'Internal' : t.direction === 'out' ? 'To store' : 'From store'}
        </span>
      ),
      sortValue: (t) => t.direction,
    },
    {
      key: 'lines',
      header: 'Lines',
      numeric: true,
      cell: (t) => t.lineCount,
      sortValue: (t) => t.lineCount,
    },
    {
      key: 'qty',
      header: 'Units',
      numeric: true,
      cell: (t) => formatQty(t.totalQty),
      sortValue: (t) => t.totalQty,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>,
      sortValue: (t) => t.status,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={transfers}
      getRowKey={(t) => t.id}
      onRowClick={(t) => router.push(`/transfers/${t.id}`)}
      empty={{
        title: 'No transfers yet',
        hint: 'A transfer moves stock from one location to another without changing what the business owns in total.',
        icon: <Icons.ArrowLeftRight size={22} />,
      }}
    />
  )
}
