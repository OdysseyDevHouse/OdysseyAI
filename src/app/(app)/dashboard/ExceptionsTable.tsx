'use client'

import { Badge, DataTable, EmptyState, Icons, type Column } from '@/components/ui'
import type { ExceptionRow } from '@/lib/site/salesReports'
import { money, count } from './format'

/**
 * Voids, credits and no-receipt returns, by whoever rang them.
 *
 * ── WHY THIS IS BEHIND `reports.view` AND NOT `dashboard.view` ───────────
 *
 * Every other widget describes the shop. This one describes named staff, and
 * it is the raw material of an accusation. A shop must be able to show a floor
 * manager the day's turnover without also showing them who voids the most, so
 * this sits behind the reports capability rather than the dashboard one.
 *
 * It is NOT proof of anything on its own — a busy till voids more than a quiet
 * one, and the till that handles returns will always lead this table. It is a
 * prompt to ask, which is why the columns are counts beside their values
 * rather than a single "suspicion" score that would pretend to a certainty
 * this data does not have.
 */

const COLUMNS: readonly Column<ExceptionRow>[] = [
  {
    key: 'userName',
    header: 'Cashier',
    cell: (r) => (
      <span className="block truncate font-medium text-ink" title={r.userName}>
        {r.userName || '—'}
      </span>
    ),
    sortable: true,
    sortValue: (r) => r.userName.toLowerCase(),
  },
  {
    key: 'voids',
    header: 'Voids',
    numeric: true,
    sortable: true,
    sortValue: (r) => r.voidValue,
    cell: (r) => (
      <span title={`${count(r.voids)} voids`}>
        {count(r.voids)}
        <span className="ml-1.5 text-muted">{money(r.voidValue)}</span>
      </span>
    ),
    width: 'w-40',
  },
  {
    key: 'creditNotes',
    header: 'Credits',
    numeric: true,
    sortable: true,
    sortValue: (r) => r.creditValue,
    cell: (r) => (
      <span title={`${count(r.creditNotes)} credit notes`}>
        {count(r.creditNotes)}
        <span className="ml-1.5 text-muted">{money(r.creditValue)}</span>
      </span>
    ),
    width: 'w-40',
  },
  {
    /* The one column that carries a judgement: goods taken back with no
       document behind them. Everything else here is ordinary trading. */
    key: 'noReceiptReturns',
    header: 'No receipt',
    numeric: true,
    sortable: true,
    sortValue: (r) => r.noReceiptReturns,
    cell: (r) =>
      r.noReceiptReturns > 0 ? (
        <Badge tone="danger">{count(r.noReceiptReturns)}</Badge>
      ) : (
        <span className="text-faint">—</span>
      ),
    width: 'w-28',
  },
]

export function ExceptionsTable({ rows }: { rows: ExceptionRow[] | null }) {
  // Null means the caller lacks `reports.view` — the figures were never put on
  // the wire. Distinct from an empty array, which is a clean period.
  if (rows === null) {
    return (
      <EmptyState
        icon={<Icons.Lock size={22} />}
        title="Not available"
        hint="Your role does not include reports."
      />
    )
  }

  return (
    <DataTable
      columns={COLUMNS}
      rows={rows}
      getRowKey={(r) => r.userId}
      empty={{
        icon: <Icons.Check size={22} />,
        title: 'Nothing to flag',
        hint: 'No voids, credits or no-receipt returns in this period.',
      }}
    />
  )
}
