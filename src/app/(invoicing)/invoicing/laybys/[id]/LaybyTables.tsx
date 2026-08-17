'use client'

import type { LaybyPayment } from '@/lib/site/laybys'
import { formatMoney, formatQty } from '@/lib/decimals'
import { Badge, type BadgeTone, DataTable, Icons, type Column } from '@/components/ui'

/**
 * The lay-by detail tables. Client components only because DataTable's column
 * cells are functions, which a Server Component cannot pass across the
 * boundary — the page hands down pre-formatted, serialisable rows.
 */

type PaymentKind = LaybyPayment['kind']

/* Local until sales/status.ts exists — never print the raw enum. */
const PAYMENT_KIND_LABELS: Record<PaymentKind, string> = {
  deposit: 'Deposit',
  instalment: 'Payment',
  refund: 'Refund',
  forfeit: 'Forfeit',
}
const PAYMENT_KIND_TONE: Record<PaymentKind, BadgeTone> = {
  deposit: 'success',
  instalment: 'success',
  refund: 'neutral',
  forfeit: 'danger',
}

export type LaybyItemRow = {
  id: number
  description: string
  productCode: string | null
  qty: number
  unitPriceIncl: number
  lineTotalIncl: number
}

const ITEM_COLUMNS: readonly Column<LaybyItemRow>[] = [
  {
    key: 'item',
    header: 'Item',
    cell: (line) => (
      <>
        <div className="text-ink">{line.description}</div>
        {line.productCode && <div className="text-xs text-muted">{line.productCode}</div>}
      </>
    ),
    sortable: true,
    sortValue: (line) => line.description,
  },
  {
    key: 'qty',
    header: 'Qty',
    numeric: true,
    sortable: true,
    cell: (line) => formatQty(line.qty),
    sortValue: (line) => line.qty,
  },
  {
    key: 'price',
    header: 'Price',
    numeric: true,
    sortable: true,
    cell: (line) => formatMoney(line.unitPriceIncl),
    sortValue: (line) => line.unitPriceIncl,
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    sortable: true,
    cell: (line) => <span className="text-ink">{formatMoney(line.lineTotalIncl)}</span>,
    sortValue: (line) => line.lineTotalIncl,
  },
]

export function LaybyItemsTable({ rows }: { rows: LaybyItemRow[] }) {
  return <DataTable columns={ITEM_COLUMNS} rows={rows} getRowKey={(line) => line.id} />
}

export type LaybyPaymentRow = {
  id: number
  paidOn: string
  kind: PaymentKind
  tenderName: string
  userName: string
  amount: number
}

const PAYMENT_COLUMNS: readonly Column<LaybyPaymentRow>[] = [
  { key: 'date', header: 'Date', sortable: true, cell: (payment) => payment.paidOn },
  {
    key: 'kind',
    header: 'Kind',
    cell: (payment) => (
      <Badge tone={PAYMENT_KIND_TONE[payment.kind]}>{PAYMENT_KIND_LABELS[payment.kind]}</Badge>
    ),
    sortable: true,
    sortValue: (payment) => payment.kind,
  },
  {
    key: 'tender',
    header: 'Tender',
    cell: (payment) => payment.tenderName || <span className="text-faint">—</span>,
    sortable: true,
    sortValue: (payment) => payment.tenderName ?? '',
  },
  {
    key: 'takenBy',
    header: 'Taken by',
    cell: (payment) => payment.userName || <span className="text-faint">—</span>,
    sortable: true,
    sortValue: (payment) => payment.userName ?? '',
  },
  {
    // Money leaving — a refund or forfeit — is an exception worth marking,
    // not something to grey out.
    key: 'amount',
    header: 'Amount',
    numeric: true,
    sortable: true,
    cell: (payment) => (
      <span className={payment.amount < 0 ? 'text-danger' : 'text-ink'}>
        {formatMoney(payment.amount)}
      </span>
    ),
    sortValue: (payment) => payment.amount,
  },
]

export function LaybyPaymentsTable({ rows }: { rows: LaybyPaymentRow[] }) {
  return (
    <DataTable
      columns={PAYMENT_COLUMNS}
      rows={rows}
      getRowKey={(payment) => payment.id}
      empty={{
        icon: <Icons.Coins size={22} />,
        title: 'Nothing paid yet',
        hint: 'Take the first instalment with “Take a payment” in the header.',
      }}
    />
  )
}
