'use client'

import { Badge, DataTable, type Column } from '@/components/ui'
import { formatQty } from '@/lib/decimals'
import type { TransferLine } from '@/lib/site/stockTransfers'

/**
 * The lines table lives on the client so its columns — cell renderers and sort
 * accessors are functions — never cross the server boundary. The lines
 * themselves are plain data and pass straight through.
 */
const LINE_COLUMNS: readonly Column<TransferLine>[] = [
  {
    key: 'code',
    header: 'Code',
    sortable: true,
    sortValue: (line) => line.productCode ?? '',
    cell: (line) => <span className="text-ink">{line.productCode ?? '—'}</span>,
  },
  {
    key: 'description',
    header: 'Description',
    sortable: true,
    sortValue: (line) => line.description,
    cell: (line) => line.description,
  },
  {
    key: 'qty',
    header: 'Quantity',
    numeric: true,
    sortable: true,
    sortValue: (line) => line.qty,
    cell: (line) => formatQty(line.qty),
  },
]

/*
 * The received column only exists on a store transfer, and only once somebody
 * has answered. Adding it unconditionally would put an empty column on every
 * internal transfer in the app to serve a case those documents never have.
 */
const RECEIVED_COLUMN: Column<TransferLine> = {
  key: 'received',
  header: 'Received',
  numeric: true,
  sortable: true,
  sortValue: (line) => line.qtyReceived ?? -1,
  cell: (line) => {
    if (line.qtyReceived === null) return <span className="text-faint">—</span>
    const missing = line.qty - line.qtyReceived
    // The shortfall is the point: it is stock that left one store and reached
    // nobody, so it must not read as an ordinary quantity.
    if (missing > 0.0005) {
      return (
        <span className="flex items-center justify-end gap-2">
          <span className="numeric">{formatQty(line.qtyReceived)}</span>
          <Badge tone="danger">{formatQty(missing)} short</Badge>
        </span>
      )
    }
    return formatQty(line.qtyReceived)
  },
}

export default function TransferLinesTable({ lines }: { lines: TransferLine[] }) {
  const columns = lines.some((l) => l.qtyReceived !== null)
    ? [...LINE_COLUMNS, RECEIVED_COLUMN]
    : LINE_COLUMNS

  return <DataTable columns={columns} rows={lines} getRowKey={(line) => line.id} />
}
