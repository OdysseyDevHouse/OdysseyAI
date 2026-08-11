'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { SalesDocStatus } from '@/lib/site/salesDocuments'
import { formatMoney } from '@/lib/decimals'
import { Badge, ButtonLink, Icons, DataTable, type Column } from '@/components/ui'
import { STATUS_LABELS, STATUS_TONE } from '../status'

/**
 * The invoice register — the whole life of an invoice, not one slice of it.
 *
 * A client component only because DataTable's column cells are functions, which
 * a Server Component cannot pass across the boundary — the page hands down
 * pre-formatted, serialisable rows.
 *
 * ── WHY A ROW'S LINK DEPENDS ON ITS STATUS ───────────────────────────────
 *
 * This list replaced a separate Documents screen, and the two had different
 * destinations for good reason: an unfinished invoice opens in the EDITOR
 * (/sales/invoicing/[id]) because there is still work to do on it, while a
 * finalised one opens as a RECORD (/sales/[id]) of what was issued — that
 * screen carries the credit-note and reprint actions, and refuses to edit.
 *
 * Merging the lists did not merge those destinations, so the row picks.
 */

export type InvoiceTableRow = {
  id: number
  documentNumber: string | null
  /** Pre-computed label for non-invoice documents; null for plain invoices. */
  docTypeLabel: string | null
  documentDate: string
  customerName: string | null
  reference: string | null
  terminalCode: string | null
  userName: string
  totalIncl: number
  status: SalesDocStatus
  cancelReason: string | null
}

/** Unfinished work opens in the editor; everything else opens as a record. */
function hrefFor(doc: InvoiceTableRow): string {
  return doc.status === 'draft' || doc.status === 'saved'
    ? `/sales/invoicing/${doc.id}`
    : `/sales/${doc.id}`
}

/*
 * An unnumbered document is only a "draft" while it is still being worked on.
 * A cancelled sale that never reached a number is not a draft — labelling it
 * one contradicts the Cancelled badge sitting in the same row — so it falls
 * back to a plain id.
 */
function labelFor(doc: InvoiceTableRow): string {
  if (doc.documentNumber) return doc.documentNumber
  return doc.status === 'draft' || doc.status === 'saved' ? `Draft #${doc.id}` : `#${doc.id}`
}

const COLUMNS: readonly Column<InvoiceTableRow>[] = [
  {
    key: 'number',
    header: 'Number',
    cell: (doc) => (
      <>
        <Link href={hrefFor(doc)} className="text-brand hover:underline">
          {labelFor(doc)}
        </Link>
        {doc.docTypeLabel && <div className="text-xs text-muted">{doc.docTypeLabel}</div>}
      </>
    ),
    sortable: true,
    sortValue: (doc) => labelFor(doc),
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

export default function InvoicingTable({
  rows,
  empty,
}: {
  rows: InvoiceTableRow[]
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
          href={hrefFor(doc)}
          aria-label={`View ${labelFor(doc)}`}
        >
          <Icons.Eye size={15} />
        </ButtonLink>
      )}
      empty={empty}
    />
  )
}
