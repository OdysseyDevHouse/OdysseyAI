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
