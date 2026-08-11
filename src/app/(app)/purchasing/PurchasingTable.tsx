'use client'

import { useMemo } from 'react'
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
  /** Which document this is. Drives where a draft row opens — see hrefFor. */
  docType: string
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

/**
 * Where a row opens.
 *
 * A DRAFT is unfinished work, so clicking it resumes the work rather than
 * showing a read-only copy of it with a button to carry on. The view screen is
 * for a document that has been issued or posted — something to look at, where
 * the actions are exceptional. A draft has exactly one thing anyone wants to do
 * with it, and making that a second click was the whole friction.
 *
 * Everything else — issued, finalised, void, cancelled — goes to the document,
 * because there is nothing to resume and its actions live there. So do draft
 * supplier returns: they are raised against a posted GRV and finalised in one
 * go, so there is no half-finished state to resume.
 *
 * `canEdit` is not decoration. Both destinations require purchasing.EDIT while
 * this list only requires purchasing.VIEW, so sending a view-only user to the
 * editor would land them on /not-allowed — strictly worse than the document
 * they can actually read. They keep the old behaviour.
 *
 * These two destinations are the same ones PurchaseActions offers on the
 * document screen; change them there and here together.
 */
export function hrefFor(doc: PurchasingRow, canEdit: boolean): string {
  if (canEdit && doc.status === 'draft') {
    if (doc.docType === 'purchase_order') return `/purchasing/${doc.id}/edit`
    if (doc.docType === 'grv') return `/purchasing/receive?draft=${doc.id}`
  }
  return `/purchasing/${doc.id}`
}

/** Built per render because the first column's link depends on canEdit. */
const columnsFor = (canEdit: boolean): readonly Column<PurchasingRow>[] => [
  {
    key: 'number',
    header: 'Number',
    sortable: true,
    sortValue: (doc) => doc.documentNumber ?? `Draft #${doc.id}`,
    cell: (doc) => (
      <div>
        <Link href={hrefFor(doc, canEdit)} className="text-brand hover:underline">
          {doc.documentNumber ?? `Draft #${doc.id}`}
        </Link>
        {/* Says where the click goes, because a draft row now goes somewhere
            different from every other row and the number alone does not show
            that. "Draft #12 · Order — continue" is the whole explanation. */}
        <div className="text-xs text-muted">
          {doc.docLabel}
          {doc.status === 'draft' && hrefFor(doc, canEdit) !== `/purchasing/${doc.id}` && (
            <span className="text-brand"> — continue</span>
          )}
        </div>
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
  canEdit,
}: {
  rows: PurchasingRow[]
  search?: string
  filtered: boolean
  /** Whether this user holds purchasing.edit. Decides where a draft opens. */
  canEdit: boolean
}) {
  const columns = useMemo(() => columnsFor(canEdit), [canEdit])

  return (
    <DataTable
      columns={columns}
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
