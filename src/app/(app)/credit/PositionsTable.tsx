'use client'

import Link from 'next/link'
import { Badge, DataTable, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { RISK_LABELS, type RiskBand } from '@/lib/creditModel'

/**
 * The overdue-accounts table.
 *
 * ── WHY THE COLUMNS LIVE HERE AND NOT ON THE PAGE ────────────────────────
 *
 * DataTable is a client component, and a Column carries `cell` and `sortValue`
 * — functions. Functions cannot cross the server/client boundary, so defining
 * the columns in the page and passing them down fails the whole render with no
 * useful error: the screen simply does not load.
 *
 * It is easy to miss because an EMPTY table renders fine on some screens —
 * they early-return an EmptyState and never reach DataTable at all. The bug
 * only appears once there is something to show.
 *
 * The house pattern (see products/ProductsTable.tsx) is what this follows: the
 * page fetches and flattens, the client component owns the columns, and only
 * plain serialisable rows cross between them.
 */

/** Plain and serialisable — no Date survives into this. */
export type PositionRow = {
  customerId: number
  code: string
  name: string
  overdueAmount: number
  oldestDays: number
  dunningLevel: number
  lastDunnedAt: string | null
  pausedUntil: string | null
  hasOpenPromise: boolean
  openPromiseDate: string | null
  isHeld: boolean
  risk: RiskBand
  riskReason: string
}

export function PositionsTable({ rows, today }: { rows: PositionRow[]; today: string }) {
  const columns: Column<PositionRow>[] = [
    {
      key: 'account',
      header: 'Account',
      cell: (p) => (
        <Link href={`/customers/${p.customerId}`} className="block hover:text-brand">
          <span className="text-ink">{p.name}</span>
          <span className="mt-0.5 block text-xs text-muted">{p.code}</span>
        </Link>
      ),
      sortValue: (p) => p.name,
    },
    {
      key: 'risk',
      header: 'Risk',
      cell: (p) => (
        <>
          <Badge
            tone={
              p.risk === 'bad'
                ? 'danger'
                : p.risk === 'poor'
                  ? 'warning'
                  : p.risk === 'watch'
                    ? 'brand'
                    : 'default'
            }
          >
            {RISK_LABELS[p.risk]}
          </Badge>
          {/* The band always carries the fact that caused it — a collector
              reads "3 promises broken", never an opaque score. */}
          <span className="mt-0.5 block text-xs text-muted">{p.riskReason}</span>
        </>
      ),
      sortValue: (p) => ['good', 'watch', 'poor', 'bad'].indexOf(p.risk),
    },
    {
      key: 'overdue',
      header: 'Overdue',
      numeric: true,
      cell: (p) => <span className="text-ink">{formatMoney(p.overdueAmount)}</span>,
      sortValue: (p) => p.overdueAmount,
    },
    {
      key: 'age',
      header: 'Oldest',
      numeric: true,
      cell: (p) => (
        <span className={p.oldestDays >= 60 ? 'text-danger' : 'text-ink-2'}>
          {p.oldestDays} days
        </span>
      ),
      sortValue: (p) => p.oldestDays,
    },
    {
      key: 'level',
      header: 'Chased',
      cell: (p) =>
        p.dunningLevel === 0 ? (
          <span className="text-faint">Never</span>
        ) : (
          <>
            <span className="text-ink-2">Level {p.dunningLevel}</span>
            {p.lastDunnedAt && (
              <span className="mt-0.5 block text-xs text-muted">{p.lastDunnedAt}</span>
            )}
          </>
        ),
      sortValue: (p) => p.dunningLevel,
    },
    {
      key: 'state',
      header: 'Status',
      // Why an account will NOT be chased, stated on the row. Without it the
      // list looks like 60 accounts nobody is bothering to phone.
      cell: (p) =>
        p.isHeld ? (
          <Badge tone="danger">On hold</Badge>
        ) : p.hasOpenPromise ? (
          <Badge tone="success">Promised {p.openPromiseDate}</Badge>
        ) : p.pausedUntil && p.pausedUntil >= today ? (
          <Badge tone="default">Paused</Badge>
        ) : (
          <span className="text-faint">—</span>
        ),
      sortValue: (p) => (p.isHeld ? 3 : p.hasOpenPromise ? 2 : p.pausedUntil ? 1 : 0),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(p) => p.customerId}
      empty={{ title: 'No accounts', hint: 'Nothing in this filter.' }}
    />
  )
}
