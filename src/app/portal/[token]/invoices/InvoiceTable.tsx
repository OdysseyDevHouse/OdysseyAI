'use client'

import { Badge, DataTable, Icons, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import PayButton from './PayButton'

/**
 * The invoice list.
 *
 * A client component for the reason LedgerTable is one: a Column array holds
 * cell FUNCTIONS, which cannot cross the server boundary. The server hands over
 * plain rows.
 *
 * Its own table rather than LedgerTable, because these are DOCUMENTS rather
 * than ledger movements — no running balance, no credit notes, no signed
 * amounts to explain. Sharing one component would mean half its columns
 * switched off by a flag on every render.
 */

export type InvoiceRow = {
  id: number
  documentNumber: string | null
  /** Nullable on the source type, so the cell has to say something either way. */
  docDate: string | null
  total: number
  outstanding: number
  isPaid: boolean
}

export default function InvoiceTable({
  rows,
  token,
  allowPay,
}: {
  rows: InvoiceRow[]
  token: string
  allowPay: boolean
}) {
  const columns: Column<InvoiceRow>[] = [
    {
      key: 'number',
      header: 'Invoice',
      cell: (row) => (
        <span className="numeric font-medium text-ink">
          {row.documentNumber ?? `Invoice ${row.id}`}
        </span>
      ),
      sortValue: (row) => row.documentNumber ?? String(row.id),
    },
    {
      key: 'date',
      header: 'Date',
      cell: (row) => <span className="numeric text-ink-2">{row.docDate ?? '—'}</span>,
      sortValue: (row) => row.docDate ?? '',
    },
    {
      key: 'status',
      header: 'Status',
      /*
       * ── THE BADGE SAYS WHAT THE TOTAL CANNOT ─────────────────────────────
       *
       * It used to print "R5 678.51 owing" beside a Total column reading
       * R5 678.51 — the same figure twice on one row, which teaches nothing
       * and buries the row that IS different.
       *
       * So an untouched unpaid invoice now says "Unpaid", and the figure
       * appears only on a PART-PAID one, where what was billed and what is
       * left genuinely differ and the Total alone would mislead.
       */
      cell: (row) => {
        if (row.isPaid) return <Badge tone="success" dot>Paid</Badge>
        return Math.abs(row.outstanding - row.total) > 0.005 ? (
          <Badge tone="warning" dot>{formatMoney(row.outstanding)} left</Badge>
        ) : (
          <Badge tone="warning" dot>Unpaid</Badge>
        )
      },
      sortValue: (row) => (row.isPaid ? 0 : row.outstanding),
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      cell: (row) => formatMoney(row.total),
      sortValue: (row) => row.total,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      empty={{
        title: 'No invoices yet',
        hint: 'Anything the business invoices you for will appear here.',
        icon: <Icons.FileText size={22} />,
      }}
      actions={(row) =>
        // Hands off to the payment flow that already exists rather than
        // building a second one.
        allowPay && !row.isPaid ? <PayButton token={token} documentId={row.id} /> : null
      }
    />
  )
}
