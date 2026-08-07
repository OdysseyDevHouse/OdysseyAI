'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { SalesDocStatus } from '@/lib/site/salesDocuments'
import { formatMoney } from '@/lib/decimals'
import { Badge, ButtonLink, Icons, DataTable, type Column } from '@/components/ui'
import { STATUS_LABELS, STATUS_TONE } from './status'

/**
 * The sales-documents list. A client component only because DataTable's column
 * cells are functions, which a Server Component cannot pass across the
 * boundary — the page hands down pre-formatted, serialisable rows.
 */

export type SalesDocTableRow = {
  id: number
  documentNumber: string | null
  /** Pre-computed label for non-invoice documents; null for plain invoices. */
  docTypeLabel: string | null
  documentDate: string
  customerName: string | null
  terminalCode: string | null
  userName: string
  totalIncl: number
  status: SalesDocStatus
  cancelReason: string | null
}

const COLUMNS: readonly Column<SalesDocTableRow>[] = [
  {
    key: 'number',
    header: 'Number',
    cell: (doc) => (
      <>
        <Link href={`/sales/${doc.id}`} className="text-brand hover:underline">
          {doc.documentNumber ?? `Draft #${doc.id}`}
        </Link>
        {doc.docTypeLabel && <div className="text-xs text-muted">{doc.docTypeLabel}</div>}
      </>
    ),
    sortValue: (doc) => doc.documentNumber ?? `Draft #${doc.id}`,
    sortable: true,
  },
  {
    key: 'date',
    header: 'Date',
    cell: (doc) => doc.documentDate,
    sortable: true,
  },
  { key: 'customer', header: 'Customer', cell: (doc) => doc.customerName ?? 'Walk-in' },
  { key: 'till', header: 'Till', cell: (doc) => doc.terminalCode ?? '—' },
  { key: 'cashier', header: 'Cashier', cell: (doc) => doc.userName || '—' },
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
    sortValue: (doc) => STATUS_LABELS[doc.status],
    cell: (doc) => (
      <span title={doc.cancelReason ?? undefined}>
        <Badge tone={STATUS_TONE[doc.status]}>{STATUS_LABELS[doc.status]}</Badge>
      </span>
    ),
  },
]

export default function SalesTable({
  rows,
  empty,
}: {
  rows: SalesDocTableRow[]
  empty: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }
}) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      getRowKey={(doc) => doc.id}
      actionsOnHover
      actions={(doc) => (
        <ButtonLink
          variant="ghost"
          size="sm"
          iconOnly
          href={`/sales/${doc.id}`}
          aria-label={`View ${doc.documentNumber ?? `draft #${doc.id}`}`}
        >
          <Icons.Eye size={15} />
        </ButtonLink>
      )}
      empty={empty}
    />
  )
}
