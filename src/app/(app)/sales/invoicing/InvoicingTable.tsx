'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { formatMoney } from '@/lib/decimals'
import { Badge, DataTable, type Column } from '@/components/ui'

/**
 * The in-progress-invoices list. A client component only because DataTable's
 * column cells are functions, which a Server Component cannot pass across the
 * boundary — the page hands down pre-formatted, serialisable rows.
 */

export type InvoiceTableRow = {
  id: number
  documentNumber: string | null
  documentDate: string
  customerName: string | null
  reference: string | null
  totalIncl: number
  status: 'draft' | 'saved'
}

const COLUMNS: readonly Column<InvoiceTableRow>[] = [
  {
    key: 'number',
    header: 'Number',
    cell: (doc) => (
      <Link href={`/sales/invoicing/${doc.id}`} className="text-brand hover:underline">
        {doc.documentNumber ?? `Invoice #${doc.id}`}
      </Link>
    ),
    sortable: true,
    sortValue: (doc) => doc.documentNumber ?? `#${doc.id}`,
  },
  { key: 'date', header: 'Date', sortable: true, cell: (doc) => doc.documentDate },
  {
    key: 'customer',
    header: 'Customer',
    sortable: true,
    cell: (doc) => doc.customerName ?? 'Walk-in',
  },
  {
    key: 'reference',
    header: 'Order number',
    cell: (doc) => doc.reference ?? <span className="text-faint">—</span>,
    sortable: true,
    sortValue: (doc) => doc.reference ?? '',
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    sortable: true,
    cell: (doc) => formatMoney(doc.totalIncl),
    sortValue: (doc) => doc.totalIncl,
  },
  {
    // Saved is the louder state — it means someone finished capturing and the
    // invoice is waiting to be finalised. A draft is just unfinished typing.
    key: 'status',
    header: 'Status',
    cell: (doc) => (
      <Badge tone={doc.status === 'saved' ? 'warning' : 'neutral'}>
        {doc.status === 'saved' ? 'Saved' : 'Draft'}
      </Badge>
    ),
    sortable: true,
    sortValue: (doc) => doc.status,
  },
]

export default function InvoicingTable({
  rows,
  empty,
}: {
  rows: InvoiceTableRow[]
  empty: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }
}) {
  return <DataTable columns={COLUMNS} rows={rows} getRowKey={(doc) => doc.id} empty={empty} />
}
