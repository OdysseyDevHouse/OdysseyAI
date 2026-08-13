'use client'

import Link from 'next/link'
import { formatMoney } from '@/lib/decimals'
import { Badge, DataTable, Icons, Menu, MenuItem, type Column } from '@/components/ui'

/**
 * The ledger-entries table, as a client component.
 *
 * A separate client file because the page is a Server Component and DataTable
 * columns are functions, which cannot cross the server→client boundary. The
 * page maps the batches into plain rows; the columns live here.
 */

export type BatchRow = {
  id: number
  journalDate: string
  journalNumber: string | null
  description: string
  isReversal: boolean
  source: string
  status: 'draft' | 'posted' | 'void'
  totalDebit: number
}

export function JournalsTable({ rows }: { rows: BatchRow[] }) {
  const columns: Column<BatchRow>[] = [
    {
      key: 'date',
      header: 'Date',
      sortable: true,
      cell: (b) => b.journalDate,
      sortValue: (b) => b.journalDate,
    },
    {
      key: 'number',
      header: 'Number',
      sortable: true,
      cell: (b) => (
        <Link href={`/accounting/journals/${b.id}`} className="text-brand hover:underline">
          {b.journalNumber ?? `#${b.id}`}
        </Link>
      ),
      sortValue: (b) => b.journalNumber ?? `#${b.id}`,
    },
    {
      key: 'description',
      header: 'Description',
      sortable: true,
      cell: (b) => (
        <>
          <span className="text-ink">{b.description}</span>
          {b.isReversal && (
            <Badge tone="default" className="ml-2">
              Reversal
            </Badge>
          )}
          {/* A draft has moved nothing — the badge is what tells a reader the
              amount beside it is not yet in any statement. */}
          {b.status === 'draft' && (
            <Badge tone="warning" className="ml-2">
              Draft
            </Badge>
          )}
        </>
      ),
      sortValue: (b) => b.description,
    },
    {
      key: 'source',
      header: 'Raised by',
      sortable: true,
      cell: (b) =>
        // A hand-written journal is the one worth noticing.
        b.source === 'manual' ? (
          <Badge tone="warning">Manual</Badge>
        ) : (
          <span className="text-muted">{sourceLabel(b.source)}</span>
        ),
      sortValue: (b) => b.source,
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      sortable: true,
      cell: (b) => formatMoney(b.totalDebit),
      sortValue: (b) => b.totalDebit,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(b) => b.id}
      actions={(b) => (
        <Menu
          iconOnly
          size="sm"
          variant="bare"
          triggerLabel={`Actions for journal ${b.journalNumber ?? `#${b.id}`}`}
          label={<Icons.MoreVertical size={16} />}
        >
          <MenuItem href={`/accounting/journals/${b.id}`}>
            <Icons.Eye size={15} />
            View journal
          </MenuItem>
        </Menu>
      )}
      empty={{
        title: 'No journals in this period',
        hint: 'Sales, purchases and expenses post here as they are captured. A manual journal is for corrections and anything the documents cannot express.',
      }}
    />
  )
}

/* Sentence-case the machine source: 'sale' → 'Sale', 'credit_note' → 'Credit note'. */
function sourceLabel(source: string) {
  const words = source.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
