'use client'

import Link from 'next/link'
import { Badge, DataTable, Icons, Menu, MenuItem, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
// The pure model, NOT lib/site/quotes — importing the server module from a
// client component pulls the database layer into the browser bundle.
import { QUOTE_STATE_LABELS, QUOTE_STATE_TONES, type QuoteState } from '@/lib/quotesModel'

/**
 * The quote register table.
 *
 * A client component because DataTable is one, and a Column carries `cell` and
 * `sortValue` — functions, which cannot cross the server/client boundary.
 * Defining them on the page fails the render outright, and the failure hides
 * until there is at least one row: an empty register early-returns an
 * EmptyState and never reaches DataTable at all.
 */

export type QuoteTableRow = {
  id: number
  documentNumber: string | null
  documentDate: string
  customerName: string | null
  state: QuoteState
  validUntil: string | null
  daysRemaining: number | null
  totalIncl: number
}

export function QuotesTable({ rows }: { rows: QuoteTableRow[] }) {
  const columns: Column<QuoteTableRow>[] = [
    {
      key: 'number',
      header: 'Number',
      cell: (q) => (
        <Link href={`/invoicing/quotes/${q.id}`} className="block hover:text-brand">
          <span className="text-ink">{q.documentNumber ?? `Draft #${q.id}`}</span>
          <span className="mt-0.5 block text-xs text-muted">{q.documentDate}</span>
        </Link>
      ),
      sortValue: (q) => q.documentNumber ?? '',
    },
    {
      key: 'customer',
      header: 'Customer',
      cell: (q) => <span className="text-ink">{q.customerName ?? 'Not stated'}</span>,
      sortValue: (q) => q.customerName ?? '',
    },
    {
      key: 'state',
      header: 'State',
      /* Tone from the shared model, not decided here: the till shows the same
         states, and a quote that reads green on one screen and grey on the
         other is two answers to one question. */
      cell: (q) => (
        <Badge dot tone={QUOTE_STATE_TONES[q.state]}>
          {QUOTE_STATE_LABELS[q.state]}
        </Badge>
      ),
      sortValue: (q) => q.state,
    },
    {
      key: 'valid',
      header: 'Valid until',
      cell: (q) =>
        q.validUntil === null ? (
          <span className="text-faint">No expiry</span>
        ) : (
          <>
            <span className={q.state === 'expired' ? 'text-danger' : 'text-ink-2'}>
              {q.validUntil}
            </span>
            {/* Days left only where it is actionable — a quote expiring in a
                week is a phone call; one expiring in three months is not. */}
            {q.state === 'open' && q.daysRemaining !== null && q.daysRemaining <= 7 && (
              <span className="mt-0.5 block text-xs text-warning-ink">
                {q.daysRemaining <= 0
                  ? 'expires today'
                  : `${q.daysRemaining} day${q.daysRemaining === 1 ? '' : 's'} left`}
              </span>
            )}
          </>
        ),
      sortValue: (q) => q.validUntil ?? '',
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      cell: (q) => <span className="text-ink">{formatMoney(q.totalIncl)}</span>,
      sortValue: (q) => q.totalIncl,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(q) => q.id}
      actions={(q) => (
        <Menu
          iconOnly
          size="sm"
          variant="bare"
          triggerLabel={`Actions for ${q.documentNumber ?? `draft quote #${q.id}`}`}
          label={<Icons.MoreVertical size={16} />}
        >
          <MenuItem href={`/invoicing/quotes/${q.id}`}>
            <Icons.Eye size={15} />
            View quote
          </MenuItem>
        </Menu>
      )}
      empty={{ title: 'No quotes', hint: 'Nothing in this filter.' }}
    />
  )
}
