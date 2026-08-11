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

type StockTakeDriftRow = {
  stockTakeId: number
  documentNumber: string | null
  productId: number
  productCode: string | null
  expected: number
  moved: number
}

/**
 * Posted count lines whose variance does not match the movement it wrote.
 *
 * Shaped differently from the stock table above because the comparison is
 * different: this is not "a stored total against a computed one" but "what the
 * sheet says it wrote against what the ledger actually received". A half-written
 * post is the failure it exists to catch.
 */
export function StockTakeDriftTable({ rows }: { rows: StockTakeDriftRow[] }) {
  const columns: Column<StockTakeDriftRow>[] = [
    {
      key: 'sheet',
      header: 'Stock take',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? '',
      cell: (r) => (
        <TextLink href={`/stock-takes/${r.stockTakeId}`}>
          {r.documentNumber ?? `#${r.stockTakeId}`}
        </TextLink>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      sortable: true,
      sortValue: (r) => r.productCode ?? '',
      cell: (r) => (
        <TextLink href={`/products/${r.productId}`}>{r.productCode ?? `#${r.productId}`}</TextLink>
      ),
    },
    {
      key: 'expected',
      header: 'Line says',
      numeric: true,
      cell: (r) => formatQty(r.expected),
    },
    {
      key: 'moved',
      header: 'Movements say',
      numeric: true,
      cell: (r) => formatQty(r.moved),
    },
    {
      key: 'drift',
      header: 'Difference',
      numeric: true,
      sortable: true,
      sortValue: (r) => Math.abs(r.expected - r.moved),
      cell: (r) => <Badge tone="danger">{formatQty(r.expected - r.moved)}</Badge>,
    },
  ]
  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => `${r.stockTakeId}-${r.productId}`}
    />
  )
}

type BuildDriftRow = {
  orderId: number
  documentNumber: string | null
  productId: number
  productCode: string | null
  expected: number
  moved: number
}

/**
 * Posted builds whose movements do not match what the build says it did.
 *
 * One row can mean either half of a build drifted: an ingredient whose
 * manufacture_out does not equal what the line consumed, or a finished quantity
 * whose manufacture_in does not equal what was built. Both name the product, so
 * which half it is reads off the row.
 */
export function BuildDriftTable({ rows }: { rows: BuildDriftRow[] }) {
  const columns: Column<BuildDriftRow>[] = [
    {
      key: 'build',
      header: 'Build',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? '',
      cell: (r) => (
        <TextLink href={`/manufacturing/${r.orderId}`}>
          {r.documentNumber ?? `#${r.orderId}`}
        </TextLink>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      sortable: true,
      sortValue: (r) => r.productCode ?? '',
      cell: (r) => (
        <TextLink href={`/products/${r.productId}`}>{r.productCode ?? `#${r.productId}`}</TextLink>
      ),
    },
    {
      key: 'expected',
      header: 'Build says',
      numeric: true,
      cell: (r) => formatQty(r.expected),
    },
    {
      key: 'moved',
      header: 'Movements say',
      numeric: true,
      cell: (r) => formatQty(r.moved),
    },
    {
      key: 'drift',
      header: 'Difference',
      numeric: true,
      sortable: true,
      sortValue: (r) => Math.abs(r.expected - r.moved),
      cell: (r) => <Badge tone="danger">{formatQty(r.expected - r.moved)}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => `${r.orderId}-${r.productId}`} />
}

type TransferDriftRow = {
  transferId: number
  documentNumber: string | null
  productId: number
  productCode: string | null
  expected: number
  movedOut: number
  movedIn: number
}

/**
 * Posted transfer lines whose two halves do not match the line.
 *
 * A transfer writes EXACTLY two movements per line — out of the source, into
 * the destination — so both are shown. A row where only one half is wrong is
 * the signature this table exists to catch: it breaks invariant (C) while
 * leaving (A) intact, so the stock table above stays clean and says nothing.
 */
export function TransferDriftTable({ rows }: { rows: TransferDriftRow[] }) {
  const columns: Column<TransferDriftRow>[] = [
    {
      key: 'transfer',
      header: 'Transfer',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? '',
      cell: (r) => (
        <TextLink href={`/transfers/${r.transferId}`}>
          {r.documentNumber ?? `#${r.transferId}`}
        </TextLink>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      sortable: true,
      sortValue: (r) => r.productCode ?? '',
      cell: (r) => (
        <TextLink href={`/products/${r.productId}`}>{r.productCode ?? `#${r.productId}`}</TextLink>
      ),
    },
    {
      key: 'expected',
      header: 'Line says',
      numeric: true,
      cell: (r) => formatQty(r.expected),
    },
    {
      key: 'out',
      header: 'Moved out',
      numeric: true,
      cell: (r) => (
        <span className={Math.abs(r.expected - r.movedOut) > 0.0005 ? 'text-danger' : undefined}>
          {formatQty(r.movedOut)}
        </span>
      ),
    },
    {
      key: 'in',
      header: 'Moved in',
      numeric: true,
      cell: (r) => (
        <span className={Math.abs(r.expected - r.movedIn) > 0.0005 ? 'text-danger' : undefined}>
          {formatQty(r.movedIn)}
        </span>
      ),
    },
  ]
  return (
    <DataTable columns={columns} rows={rows} getRowKey={(r) => `${r.transferId}-${r.productId}`} />
  )
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

type AdjustmentDriftRow = {
  adjustmentId: number
  documentNumber: string | null
  productId: number
  productCode: string | null
  expected: number
  moved: number
}

/**
 * Posted adjustment lines whose movement does not match the line.
 *
 * One movement per line here, not two — an adjustment is deliberately one-sided,
 * because the business genuinely owns more or less than it did. So there is a
 * single figure to compare rather than an out and an in.
 */
export function AdjustmentDriftTable({ rows }: { rows: AdjustmentDriftRow[] }) {
  const columns: Column<AdjustmentDriftRow>[] = [
    {
      key: 'adjustment',
      header: 'Adjustment',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? '',
      cell: (r) => (
        <TextLink href={`/adjustments/${r.adjustmentId}`}>
          {r.documentNumber ?? `#${r.adjustmentId}`}
        </TextLink>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      sortable: true,
      sortValue: (r) => r.productCode ?? '',
      cell: (r) => (
        <TextLink href={`/products/${r.productId}`}>{r.productCode ?? `#${r.productId}`}</TextLink>
      ),
    },
    {
      key: 'expected',
      header: 'Line says',
      numeric: true,
      cell: (r) => formatQty(r.expected),
    },
    {
      key: 'moved',
      header: 'Actually moved',
      numeric: true,
      cell: (r) => (
        <span className={Math.abs(r.expected - r.moved) > 0.0005 ? 'text-danger' : undefined}>
          {formatQty(r.moved)}
        </span>
      ),
    },
  ]
  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => `${r.adjustmentId}-${r.productId}`}
    />
  )
}

type StoreTransferDriftRow = {
  transferId: number
  documentNumber: string | null
  peerSiteName: string | null
  dispatchedAt: Date | string | null
  totalQty: number
  problem: string
}

/**
 * Dispatches to other stores that have not completed.
 *
 * Unlike every other table here, a row is not necessarily a BUG — a truck that
 * left yesterday is simply still on the road. The `problem` column says which
 * kind it is, because the two need very different responses: one needs chasing,
 * the other means the goods are counted twice across the group until somebody
 * settles the dispatch.
 */
export function StoreTransferDriftTable({ rows }: { rows: StoreTransferDriftRow[] }) {
  const columns: Column<StoreTransferDriftRow>[] = [
    {
      key: 'transfer',
      header: 'Dispatch',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? '',
      cell: (r) => (
        <TextLink href={`/transfers/${r.transferId}`}>
          {r.documentNumber ?? `#${r.transferId}`}
        </TextLink>
      ),
    },
    {
      key: 'store',
      header: 'To store',
      sortable: true,
      sortValue: (r) => r.peerSiteName ?? '',
      cell: (r) => <span className="text-ink-2">{r.peerSiteName ?? '—'}</span>,
    },
    {
      key: 'qty',
      header: 'Units',
      numeric: true,
      cell: (r) => formatQty(r.totalQty),
    },
    {
      key: 'problem',
      header: 'What is wrong',
      cell: (r) => <span className="text-muted">{r.problem}</span>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.transferId} />
}
