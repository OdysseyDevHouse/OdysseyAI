'use client'

import { DataTable, type Column } from '@/components/ui'
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

export default function TransferLinesTable({ lines }: { lines: TransferLine[] }) {
  return <DataTable columns={LINE_COLUMNS} rows={lines} getRowKey={(line) => line.id} />
}
