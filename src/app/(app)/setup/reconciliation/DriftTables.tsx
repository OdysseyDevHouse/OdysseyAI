'use client'

import { Badge, DataTable, TextLink, type Column } from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type { SequenceCheck } from '@/lib/site/sequences'

/**
 * The reconciliation screen's tables, as DataTables.
 *
 * A separate client file because the page is a Server Component and DataTable
 * columns are functions, which cannot cross the server→client boundary. The
 * page pre-sorts drift rows worst-first, so the "initial sort" is simply the
 * row order; the columns stay sortable on top of that.
 */

type StockDriftRow = {
  productId: number
  code: string
  description: string
  stored: number
  computed: number
  drift: number
}

export function StockDriftTable({ rows }: { rows: StockDriftRow[] }) {
  const columns: Column<StockDriftRow>[] = [
    {
      key: 'product',
      header: 'Product',
      sortable: true,
      sortValue: (r) => r.code,
      cell: (r) => (
        <div>
          <TextLink href={`/products/${r.productId}`}>{r.code}</TextLink>
          <div className="text-ink">{r.description}</div>
        </div>
      ),
    },
    { key: 'stored', header: 'Stored', numeric: true, cell: (r) => formatQty(r.stored) },
    {
      key: 'computed',
      header: 'From movements',
      numeric: true,
      cell: (r) => formatQty(r.computed),
    },
    {
      key: 'drift',
      header: 'Difference',
      numeric: true,
      sortable: true,
      sortValue: (r) => Math.abs(r.drift),
      // The drift is the exception; badge it per row rather than painting the
      // whole column danger, so the eye lands on the value, not the heading.
      cell: (r) =>
        r.drift === 0 ? (
          <span className="text-faint">0</span>
        ) : (
          <Badge tone="danger">{formatQty(r.drift)}</Badge>
        ),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.productId} />
}

type BalanceDriftRow = {
  id: number
  code: string
  name: string
  stored: number
  computed: number
  drift: number
}

export function BalanceDriftTable({
  rows,
  hrefBase,
}: {
  rows: BalanceDriftRow[]
  hrefBase: string
}) {
  const columns: Column<BalanceDriftRow>[] = [
    {
      key: 'account',
      header: 'Account',
      sortable: true,
      sortValue: (r) => r.code,
      cell: (r) => (
        <div>
          <TextLink href={`${hrefBase}/${r.id}`}>{r.code}</TextLink>
          <div className="text-ink">{r.name}</div>
        </div>
      ),
    },
    { key: 'stored', header: 'Stored', numeric: true, cell: (r) => formatMoney(r.stored) },
    { key: 'computed', header: 'From ledger', numeric: true, cell: (r) => formatMoney(r.computed) },
    {
      key: 'drift',
      header: 'Difference',
      numeric: true,
      sortable: true,
      sortValue: (r) => Math.abs(r.drift),
      cell: (r) =>
        r.drift === 0 ? (
          <span className="text-faint">0</span>
        ) : (
          <Badge tone="danger">{formatMoney(r.drift)}</Badge>
        ),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} />
}

export function SequenceTable({ checks }: { checks: SequenceCheck[] }) {
  const columns: Column<SequenceCheck>[] = [
    {
      key: 'sequence',
      header: 'Sequence',
      sortable: true,
      sortValue: (c) => c.docType,
      cell: (c) => (
        <div>
          {c.docType}
          {c.firstNumber && (
            <div className="text-xs text-muted">
              {c.firstNumber} – {c.lastNumber}
            </div>
          )}
        </div>
      ),
    },
    { key: 'issued', header: 'Issued', numeric: true, sortValue: (c) => c.issued, cell: (c) => c.issued },
    { key: 'live', header: 'Live', numeric: true, sortValue: (c) => c.live, cell: (c) => c.live },
    {
      key: 'voided',
      header: 'Voided',
      numeric: true,
      sortValue: (c) => c.voided,
      // A voided document is an EXPLAINABLE gap — it keeps its number and its
      // reason, which is what the law asks for.
      cell: (c) => (c.voided > 0 ? <Badge tone="neutral">{c.voided}</Badge> : '—'),
    },
    {
      key: 'missing',
      header: 'Unaccounted',
      numeric: true,
      sortable: true,
      sortValue: (c) => c.missing,
      cell: (c) =>
        c.missing > 0 ? <Badge tone="danger">{c.missing}</Badge> : <span className="text-faint">0</span>,
    },
  ]
  return <DataTable columns={columns} rows={checks} getRowKey={(c) => c.docType} />
}
