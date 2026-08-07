'use client'

import Link from 'next/link'
import { Badge, DataTable, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

type RemittanceStatus = 'none' | 'queued' | 'sent' | 'failed'

/**
 * The slice of a payment item the run screen renders — plain data only, so the
 * server page can pass it across the client boundary. Columns and their
 * cell/sort functions live here, on the client side, where functions may.
 */
export type RunItemRow = {
  id: number
  supplierId: number
  supplierCode: string
  supplierName: string
  email: string | null
  remittanceStatus: RemittanceStatus
  remittanceError: string | null
  /** How many invoices this payment settles — counted server-side. */
  invoiceCount: number
  amount: number
}

const REMITTANCE_TONE: Record<RemittanceStatus, 'neutral' | 'success' | 'danger'> = {
  none: 'neutral',
  queued: 'neutral',
  sent: 'success',
  failed: 'danger',
}

const REMITTANCE_LABEL: Record<RemittanceStatus, string> = {
  none: 'Not sent',
  queued: 'Queued',
  sent: 'Sent',
  failed: 'Failed',
}

/**
 * One table of suppliers rather than a card per supplier: a run is checked
 * supplier by supplier, and twelve stacked tables made the totals impossible
 * to compare. The per-invoice allocations are one drill away — the account's
 * statement while the run is a draft, the advice PDF once it is posted.
 */
export default function RunItemsTable({
  rows,
  runId,
  posted,
}: {
  rows: RunItemRow[]
  runId: number
  posted: boolean
}) {
  const columns: readonly Column<RunItemRow>[] = [
    {
      key: 'supplier',
      header: 'Supplier',
      sortable: true,
      sortValue: (item) => item.supplierName,
      cell: (item) => (
        <div>
          <Link
            href={`/suppliers/${item.supplierId}/statement`}
            className="text-ink hover:text-brand"
          >
            {item.supplierName}
          </Link>
          <div className="text-xs text-muted">
            {item.supplierCode}
            {item.email ? ` · ${item.email}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'invoices',
      header: 'Invoices',
      numeric: true,
      sortable: true,
      sortValue: (item) => item.invoiceCount,
      cell: (item) => item.invoiceCount,
    },
    {
      key: 'remittance',
      header: 'Remittance',
      sortable: true,
      sortValue: (item) => item.remittanceStatus,
      cell: (item) => (
        <div className="flex items-center gap-2">
          {!item.email ? (
            <Badge tone="warning">No email</Badge>
          ) : item.remittanceStatus === 'none' ? (
            <span className="text-faint">{REMITTANCE_LABEL.none}</span>
          ) : (
            <span title={item.remittanceError ?? undefined}>
              <Badge tone={REMITTANCE_TONE[item.remittanceStatus]}>
                {REMITTANCE_LABEL[item.remittanceStatus]}
              </Badge>
            </span>
          )}
          {posted && (
            <Link
              href={`/api/suppliers/${item.supplierId}/remittance?run=${runId}`}
              className="text-sm text-brand hover:underline"
            >
              Advice PDF
            </Link>
          )}
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      sortable: true,
      sortValue: (item) => item.amount,
      cell: (item) => <span className="font-medium text-ink">{formatMoney(item.amount)}</span>,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(item) => item.id}
      empty={{
        title: 'Nothing on this run',
        hint: 'The run has no payments — cancel it and prepare a new one.',
      }}
    />
  )
}
