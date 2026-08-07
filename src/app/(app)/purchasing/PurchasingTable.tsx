'use client'

import Link from 'next/link'
import { Badge, DataTable, Icons, PrimaryLink, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { purchaseStatusLabel, purchaseStatusTone } from './status'

/**
 * The slice of a purchase document the list renders — plain data only, so the
 * server page can pass it across the client boundary. Columns and their
 * cell/sort functions live here, on the client side, where functions may.
 */
export type PurchasingRow = {
  id: number
  documentNumber: string | null
  docLabel: string
  documentDate: string
  supplierName: string | null
  supplierInvoiceNo: string | null
  subtotalExcl: number
  totalIncl: number
  status: string
  fulfilmentStatus: string | null
  cancelReason: string | null
}

const COLUMNS: readonly Column<PurchasingRow>[] = [
  {
    key: 'number',
    header: 'Number',
    sortable: true,
    sortValue: (doc) => doc.documentNumber ?? `Draft #${doc.id}`,
    cell: (doc) => (
      <div>
        <Link href={`/purchasing/${doc.id}`} className="text-brand hover:underline">
          {doc.documentNumber ?? `Draft #${doc.id}`}
        </Link>
        <div className="text-xs text-muted">{doc.docLabel}</div>
      </div>
    ),
  },
  {
    key: 'date',
    header: 'Date',
    sortable: true,
    sortValue: (doc) => doc.documentDate,
    cell: (doc) => doc.documentDate,
  },
  {
    key: 'supplier',
    header: 'Supplier',
    sortable: true,
    sortValue: (doc) => doc.supplierName ?? '',
    cell: (doc) => doc.supplierName ?? '—',
  },
  {
    key: 'theirInvoice',
    header: 'Their invoice',
    sortable: true,
    sortValue: (doc) => doc.supplierInvoiceNo ?? '',
    cell: (doc) => doc.supplierInvoiceNo ?? '—',
  },
  {
    key: 'excl',
    header: 'Excl. VAT',
    numeric: true,
    sortable: true,
    sortValue: (doc) => doc.subtotalExcl,
    cell: (doc) => formatMoney(doc.subtotalExcl),
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    sortable: true,
    sortValue: (doc) => doc.totalIncl,
    cell: (doc) => (
      <span className={doc.status === 'cancelled' ? 'text-faint line-through' : 'text-ink'}>
        {formatMoney(doc.totalIncl)}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    sortValue: (doc) => doc.status,
    cell: (doc) => (
      <span title={doc.cancelReason ?? undefined}>
        <Badge tone={purchaseStatusTone(doc.status)}>
          {purchaseStatusLabel(doc.status, doc.fulfilmentStatus)}
        </Badge>
      </span>
    ),
  },
]

export default function PurchasingTable({
  rows,
  search,
  filtered,
}: {
  rows: PurchasingRow[]
  search?: string
  filtered: boolean
}) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      getRowKey={(doc) => doc.id}
      empty={
        filtered
          ? {
              title: search ? `Nothing matches “${search}”` : 'Nothing matches the filter',
              hint: 'Try a different search, another document type, or clear the filters.',
            }
          : {
              title: 'Nothing purchased yet',
              hint: 'Receive a delivery to get started — stock, costs and the supplier’s account are all updated in one go.',
              icon: <Icons.PackageOpen size={28} strokeWidth={1.75} />,
              action: (
                <PrimaryLink href="/purchasing/receive">
                  <Icons.PackageOpen size={15} />
                  Receive goods
                </PrimaryLink>
              ),
            }
      }
    />
  )
}
