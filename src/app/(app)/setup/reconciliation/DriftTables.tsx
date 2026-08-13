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

/*
 * ── JOB PARTS ──────────────────────────────────────────────────────────────
 *
 * Four tables rather than one, because the four drifts have nothing in common
 * except the word "parts". Squashing them into a single table with a "problem"
 * column would put a quantity mismatch next to a stranded pile and make both
 * unreadable — and only one of them is a bug.
 */

type IssuedMismatchRow = {
  lineId: number
  jobId: number
  description: string
  issued: number
  moved: number
}

export function JobIssuedDriftTable({ rows }: { rows: IssuedMismatchRow[] }) {
  const columns: Column<IssuedMismatchRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.jobId,
      cell: (r) => <TextLink href={`/jobs/${r.jobId}?tab=costs`}>#{r.jobId}</TextLink>,
    },
    {
      key: 'line',
      header: 'Part',
      sortable: true,
      sortValue: (r) => r.description,
      cell: (r) => <span className="text-ink-2">{r.description}</span>,
    },
    { key: 'issued', header: 'Line says issued', numeric: true, cell: (r) => formatQty(r.issued) },
    { key: 'moved', header: 'Transfers moved', numeric: true, cell: (r) => formatQty(r.moved) },
    {
      key: 'drift',
      header: 'Difference',
      numeric: true,
      sortable: true,
      sortValue: (r) => Math.abs(r.issued - r.moved),
      cell: (r) => <Badge tone="danger">{formatQty(r.issued - r.moved)}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.lineId} />
}

type InvoicedOutRow = {
  lineId: number
  jobId: number
  jobNumber: string | null
  description: string
  issued: number
}

export function JobInvoicedOutTable({ rows }: { rows: InvoicedOutRow[] }) {
  const columns: Column<InvoicedOutRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.jobNumber ?? '',
      cell: (r) => (
        <TextLink href={`/jobs/${r.jobId}?tab=costs`}>{r.jobNumber ?? `#${r.jobId}`}</TextLink>
      ),
    },
    {
      key: 'line',
      header: 'Part',
      sortable: true,
      sortValue: (r) => r.description,
      cell: (r) => <span className="text-ink-2">{r.description}</span>,
    },
    {
      key: 'issued',
      header: 'Still out on a van',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.issued,
      cell: (r) => <Badge tone="warning">{formatQty(r.issued)}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.lineId} />
}

type StrandedRow = {
  locationName: string
  productCode: string
  description: string
  qty: number
}

export function JobStrandedTable({ rows }: { rows: StrandedRow[] }) {
  const columns: Column<StrandedRow>[] = [
    {
      key: 'van',
      header: 'Vehicle',
      sortable: true,
      sortValue: (r) => r.locationName,
      cell: (r) => <span className="text-ink">{r.locationName}</span>,
    },
    {
      key: 'product',
      header: 'Product',
      sortable: true,
      sortValue: (r) => r.productCode,
      cell: (r) => (
        <span className="text-ink-2">
          {r.productCode} — {r.description}
        </span>
      ),
    },
    {
      key: 'qty',
      header: 'On board',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.qty,
      cell: (r) => formatQty(r.qty),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => `${r.locationName}-${r.productCode}`} />
}

type AlsoOnOrderRow = {
  lineId: number
  jobId: number
  description: string
  orderNumber: string | null
}

export function JobAlsoOnOrderTable({ rows }: { rows: AlsoOnOrderRow[] }) {
  const columns: Column<AlsoOnOrderRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.jobId,
      cell: (r) => <TextLink href={`/jobs/${r.jobId}?tab=costs`}>#{r.jobId}</TextLink>,
    },
    {
      key: 'line',
      header: 'Part',
      sortable: true,
      sortValue: (r) => r.description,
      cell: (r) => <span className="text-ink-2">{r.description}</span>,
    },
    {
      key: 'order',
      header: 'Also reserved by',
      sortable: true,
      sortValue: (r) => r.orderNumber ?? '',
      cell: (r) => <span className="text-ink-2">{r.orderNumber ?? '—'}</span>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.lineId} />
}

/* ── JOB SERVICE TARGETS ────────────────────────────────────────────────────
 *
 * Two shapes: a deadline that no longer matches what the current trading hours
 * would produce, and a response recorded before the job existed. Only the second
 * is a bug — see the page for why the first is the feature working.
 */

type StaleDeadlineRow = {
  jobId: number
  documentNumber: string | null
  priority: string
  stored: string | null
  wouldBe: string | null
}

export function JobSlaStaleTable({ rows }: { rows: StaleDeadlineRow[] }) {
  const columns: Column<StaleDeadlineRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? String(r.jobId),
      cell: (r) => (
        <TextLink href={`/jobs/${r.jobId}`}>{r.documentNumber ?? `#${r.jobId}`}</TextLink>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      sortValue: (r) => r.priority,
      cell: (r) => <span className="text-ink-2">{r.priority}</span>,
    },
    {
      key: 'stored',
      header: 'Promised',
      cell: (r) => <span className="text-ink-2">{r.stored ?? '—'}</span>,
    },
    {
      key: 'wouldBe',
      header: 'Todays hours would say',
      cell: (r) => <span className="text-muted">{r.wouldBe ?? 'no target'}</span>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.jobId} />
}

type ImpossibleResponseRow = {
  jobId: number
  documentNumber: string | null
  reportedAt: string | null
  respondedAt: string | null
}

export function JobSlaImpossibleTable({ rows }: { rows: ImpossibleResponseRow[] }) {
  const columns: Column<ImpossibleResponseRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? String(r.jobId),
      cell: (r) => (
        <TextLink href={`/jobs/${r.jobId}`}>{r.documentNumber ?? `#${r.jobId}`}</TextLink>
      ),
    },
    {
      key: 'reported',
      header: 'Reported',
      cell: (r) => <span className="text-ink-2">{r.reportedAt ?? '—'}</span>,
    },
    {
      key: 'responded',
      header: 'Responded',
      cell: (r) => <Badge tone="danger">{r.respondedAt ?? '—'}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.jobId} />
}

type UntargetedRow = { jobId: number; documentNumber: string | null; priority: string }

/**
 * Open jobs with no target.
 *
 * Its own table rather than the stale one with blanks: a "Promised" column full of
 * dashes reads as data that failed to load, when the truth is there was never
 * anything to load.
 */
export function JobSlaUntargetedTable({ rows }: { rows: UntargetedRow[] }) {
  const columns: Column<UntargetedRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? String(r.jobId),
      cell: (r) => (
        <TextLink href={`/jobs/${r.jobId}`}>{r.documentNumber ?? `#${r.jobId}`}</TextLink>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      sortValue: (r) => r.priority,
      cell: (r) => <span className="text-ink-2">{r.priority}</span>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.jobId} />
}

/* ── JOB CARDS ──────────────────────────────────────────────────────────────
 *
 * Two shapes cover the four bug checks: a line-level one for the three invoicing
 * problems, and a job-level one for a status whose role disagrees with the stored
 * open/closed flag. The board check is configuration, not drift, and gets the
 * stranded-status table below.
 */

type JobLineDriftRow = {
  lineId: number
  jobId: number
  description: string
  detail: string
}

export function JobLineDriftTable({ rows }: { rows: JobLineDriftRow[] }) {
  const columns: Column<JobLineDriftRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.jobId,
      cell: (r) => <TextLink href={`/jobs/${r.jobId}?tab=costs`}>#{r.jobId}</TextLink>,
    },
    {
      key: 'line',
      header: 'Line',
      sortable: true,
      sortValue: (r) => r.description,
      cell: (r) => <span className="text-ink-2">{r.description}</span>,
    },
    {
      key: 'detail',
      header: 'What is wrong',
      cell: (r) => <Badge tone="danger">{r.detail}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.lineId} />
}

type JobStateDriftRow = {
  jobId: number
  number: string | null
  status: string
  role: string
}

export function JobStateDriftTable({ rows }: { rows: JobStateDriftRow[] }) {
  const columns: Column<JobStateDriftRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.number ?? String(r.jobId),
      cell: (r) => <TextLink href={`/jobs/${r.jobId}`}>{r.number ?? `#${r.jobId}`}</TextLink>,
    },
    {
      key: 'stored',
      header: 'Stored as',
      sortable: true,
      sortValue: (r) => r.status,
      cell: (r) => <span className="text-ink-2">{r.status}</span>,
    },
    {
      key: 'role',
      header: 'But its stage means',
      cell: (r) => <Badge tone="danger">{r.role || 'no role'}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.jobId} />
}

type StrandedStatusRow = { statusId: number; name: string; jobCount: number }

export function JobStrandedStatusTable({ rows }: { rows: StrandedStatusRow[] }) {
  const columns: Column<StrandedStatusRow>[] = [
    {
      key: 'name',
      header: 'Stage',
      sortable: true,
      sortValue: (r) => r.name,
      cell: (r) => <span className="text-ink">{r.name}</span>,
    },
    {
      key: 'jobs',
      header: 'Jobs in it',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.jobCount,
      cell: (r) =>
        r.jobCount === 0 ? (
          <span className="text-muted">0</span>
        ) : (
          <Badge tone="warning">{r.jobCount}</Badge>
        ),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.statusId} />
}

/* ── JOB TASKS AND CHECKS ───────────────────────────────────────────────────
 *
 * Two shapes. A completed item with no answer, and a stored failure flag that
 * disagrees with the response beside it — both impossible through the app, so both
 * mean somebody edited the database or an older build wrote the row.
 */

type ItemDriftRow = {
  itemId: number
  jobId: number
  name: string
  detail: string
}

export function JobItemDriftTable({ rows }: { rows: ItemDriftRow[] }) {
  const columns: Column<ItemDriftRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.jobId,
      cell: (r) => <TextLink href={`/jobs/${r.jobId}?tab=checks`}>#{r.jobId}</TextLink>,
    },
    {
      key: 'name',
      header: 'Task or check',
      sortable: true,
      sortValue: (r) => r.name,
      cell: (r) => <span className="text-ink-2">{r.name}</span>,
    },
    {
      key: 'detail',
      header: 'What is wrong',
      cell: (r) => <Badge tone="danger">{r.detail}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.itemId} />
}

type UnclassifiedJobRow = { jobId: number; documentNumber: string | null }

/**
 * Open jobs with no kind of work, while the setting demands one.
 *
 * Only reported when `job_headline_required` is on — otherwise a job without a
 * headline is a perfectly normal job and listing it would be noise.
 */
export function JobNoHeadlineTable({ rows }: { rows: UnclassifiedJobRow[] }) {
  const columns: Column<UnclassifiedJobRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? String(r.jobId),
      cell: (r) => (
        <TextLink href={`/jobs/${r.jobId}?tab=checks`}>{r.documentNumber ?? `#${r.jobId}`}</TextLink>
      ),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.jobId} />
}

/* ── CUSTOMER EQUIPMENT ─────────────────────────────────────────────────────
 *
 * Three shapes, all of which mean somebody or something bypassed the module:
 * status out of step with is_active, a unit at a site belonging to a different
 * customer, and a job whose equipment belongs to somebody else.
 */

type AssetDriftRow = {
  assetId: number
  documentNumber: string | null
  detail: string
}

export function AssetDriftTable({ rows }: { rows: AssetDriftRow[] }) {
  const columns: Column<AssetDriftRow>[] = [
    {
      key: 'asset',
      header: 'Equipment',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? String(r.assetId),
      cell: (r) => (
        <TextLink href={`/jobs/equipment/${r.assetId}`}>
          {r.documentNumber ?? `#${r.assetId}`}
        </TextLink>
      ),
    },
    {
      key: 'detail',
      header: 'What is wrong',
      cell: (r) => <Badge tone="danger">{r.detail}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.assetId} />
}

type AssetJobDriftRow = {
  jobId: number
  documentNumber: string | null
  assetId: number
}

export function AssetJobDriftTable({ rows }: { rows: AssetJobDriftRow[] }) {
  const columns: Column<AssetJobDriftRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? String(r.jobId),
      cell: (r) => (
        <TextLink href={`/jobs/${r.jobId}`}>{r.documentNumber ?? `#${r.jobId}`}</TextLink>
      ),
    },
    {
      key: 'asset',
      header: 'Equipment',
      cell: (r) => (
        <TextLink href={`/jobs/equipment/${r.assetId}`}>#{r.assetId}</TextLink>
      ),
    },
    {
      key: 'detail',
      header: 'What is wrong',
      cell: () => <Badge tone="danger">belongs to another customer</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.jobId} />
}

type RetiredWorkedRow = {
  assetId: number
  documentNumber: string | null
  description: string
  jobCount: number
}

/**
 * Retired equipment still named by an open job.
 *
 * Informational, not a bug: naming a retired unit is ALLOWED, because somebody has
 * to be able to log the job that scrapped it. Listed so a job left open against a
 * dead unit does not sit there unnoticed.
 */
export function AssetRetiredWorkedTable({ rows }: { rows: RetiredWorkedRow[] }) {
  const columns: Column<RetiredWorkedRow>[] = [
    {
      key: 'asset',
      header: 'Retired equipment',
      sortable: true,
      sortValue: (r) => r.description,
      cell: (r) => (
        <TextLink href={`/jobs/equipment/${r.assetId}`}>
          {r.description}
          {r.documentNumber ? ` · ${r.documentNumber}` : ''}
        </TextLink>
      ),
    },
    {
      key: 'jobs',
      header: 'Open jobs',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.jobCount,
      cell: (r) => <Badge tone="warning">{r.jobCount}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.assetId} />
}

/* ── RECURRING JOBS ─────────────────────────────────────────────────────────
 *
 * The serious one is a STRANDED CLAIM: a period claimed but never raised. The
 * unique key means the next tick will not retry it, so that period of work is
 * silently lost — the only drift in this module with no symptom anywhere else.
 */

type SeriesRunDriftRow = {
  runId: number
  seriesId: number
  seriesName: string
  forDate: string
  detail: string
}

export function SeriesRunDriftTable({ rows }: { rows: SeriesRunDriftRow[] }) {
  const columns: Column<SeriesRunDriftRow>[] = [
    {
      key: 'series',
      header: 'Schedule',
      sortable: true,
      sortValue: (r) => r.seriesName,
      cell: (r) => <TextLink href="/jobs/recurring">{r.seriesName}</TextLink>,
    },
    {
      key: 'due',
      header: 'Period',
      sortable: true,
      sortValue: (r) => r.forDate,
      cell: (r) => <span className="text-ink-2">{r.forDate}</span>,
    },
    {
      key: 'detail',
      header: 'What is wrong',
      cell: (r) => <Badge tone="danger">{r.detail}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.runId} />
}

type CursorAheadRow = {
  seriesId: number
  seriesName: string
  cursor: string
  newestClaim: string | null
}

export function SeriesCursorTable({ rows }: { rows: CursorAheadRow[] }) {
  const columns: Column<CursorAheadRow>[] = [
    {
      key: 'series',
      header: 'Schedule',
      sortable: true,
      sortValue: (r) => r.seriesName,
      cell: (r) => <TextLink href="/jobs/recurring">{r.seriesName}</TextLink>,
    },
    {
      key: 'cursor',
      header: 'Cursor says',
      cell: (r) => <span className="text-ink-2">{r.cursor}</span>,
    },
    {
      key: 'claim',
      header: 'Newest actually raised',
      cell: (r) => (
        <Badge tone="danger">{r.newestClaim ?? 'nothing ever raised'}</Badge>
      ),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.seriesId} />
}

/* ── Who is on a job (120) ─────────────────────────────────────────────────── */

type GonePersonRow = { jobId: number; userId: number; userName: string; role: string }

export function GonePeopleTable({ rows }: { rows: GonePersonRow[] }) {
  const columns: Column<GonePersonRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.jobId,
      cell: (r) => <TextLink href={`/jobs/${r.jobId}`}>Job {r.jobId}</TextLink>,
    },
    {
      key: 'who',
      header: 'Person',
      sortable: true,
      sortValue: (r) => r.userName,
      cell: (r) => <span className="text-ink-2">{r.userName}</span>,
    },
    {
      key: 'role',
      header: 'As',
      cell: (r) => (
        <Badge tone={r.role === 'assignee' ? 'danger' : 'warning'}>
          {r.role === 'assignee' ? 'Assignee' : 'Follower'}
        </Badge>
      ),
    },
  ]
  return (
    <DataTable columns={columns} rows={rows} getRowKey={(r) => `${r.jobId}-${r.userId}`} />
  )
}

type NoAddressRow = { userId: number; userName: string; jobCount: number }

export function NoAddressTable({ rows }: { rows: NoAddressRow[] }) {
  const columns: Column<NoAddressRow>[] = [
    {
      key: 'who',
      header: 'Person',
      sortable: true,
      sortValue: (r) => r.userName,
      cell: (r) => <TextLink href="/staff">{r.userName}</TextLink>,
    },
    {
      key: 'jobs',
      header: 'Jobs assigned',
      sortable: true,
      sortValue: (r) => r.jobCount,
      cell: (r) => <Badge tone="warning">{r.jobCount}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.userId} />
}

/* ── Time-based automations (121) ──────────────────────────────────────────── */

type AutomationRunRow = {
  id: number
  jobId: number
  documentNumber: string | null
  jobTitle: string
  event: string
  forDate: string
  detail: string | null
}

const AUTOMATION_LABEL: Record<string, string> = {
  respond_breach: 'Response overdue',
  resolve_breach: 'Resolution overdue',
  visit_reminder: 'Visit reminder',
  auto_invoice: 'Invoice on close',
}

export function AutomationRunTable({ rows }: { rows: AutomationRunRow[] }) {
  const columns: Column<AutomationRunRow>[] = [
    {
      key: 'job',
      header: 'Job',
      sortable: true,
      sortValue: (r) => r.documentNumber ?? String(r.jobId),
      cell: (r) => (
        <TextLink href={`/jobs/${r.jobId}`}>{r.documentNumber ?? `Job ${r.jobId}`}</TextLink>
      ),
    },
    {
      key: 'what',
      header: 'What should have happened',
      cell: (r) => <span className="text-ink-2">{AUTOMATION_LABEL[r.event] ?? r.event}</span>,
    },
    {
      key: 'for',
      header: 'For',
      sortable: true,
      sortValue: (r) => r.forDate,
      cell: (r) => <span className="text-muted">{r.forDate}</span>,
    },
    {
      key: 'detail',
      header: 'Why',
      cell: (r) => <Badge tone="danger">{r.detail ?? 'no reason recorded'}</Badge>,
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} />
}

/* ── Deposits whose job is gone (33) ───────────────────────────────────────── */

type OrphanDepositRow = {
  transactionId: number
  jobId: number
  amount: number
  docDate: string
}

export function OrphanDepositTable({ rows }: { rows: OrphanDepositRow[] }) {
  const columns: Column<OrphanDepositRow>[] = [
    {
      key: 'date',
      header: 'Taken',
      sortable: true,
      sortValue: (r) => r.docDate,
      cell: (r) => <span className="text-ink-2">{r.docDate}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      sortable: true,
      sortValue: (r) => r.amount,
      cell: (r) => <span className="numeric text-ink">{formatMoney(r.amount)}</span>,
    },
    {
      key: 'job',
      header: 'Was on job',
      // Deliberately NOT a link: the job is gone, and a link to a 404 is worse
      // than a number somebody can search the activity log for.
      cell: (r) => <Badge tone="warning">#{r.jobId}</Badge>,
    },
    {
      key: 'txn',
      header: 'On the account as',
      cell: (r) => (
        <TextLink href={`/customers?txn=${r.transactionId}`}>#{r.transactionId}</TextLink>
      ),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.transactionId} />
}

/* ── Crews (126) ───────────────────────────────────────────────────────────── */

type GoneCrewMemberRow = { teamId: number; teamName: string; userId: number; userName: string }

export function GoneCrewMemberTable({ rows }: { rows: GoneCrewMemberRow[] }) {
  const columns: Column<GoneCrewMemberRow>[] = [
    {
      key: 'crew',
      header: 'Crew',
      sortable: true,
      sortValue: (r) => r.teamName,
      // The crew is edited on the workflow screen, so that is where the link
      // goes. There is no per-crew route, and inventing one for a drift table
      // would be a screen nobody else ever opens.
      cell: (r) => <TextLink href="/setup/job-workflow">{r.teamName}</TextLink>,
    },
    {
      key: 'who',
      header: 'Still on it',
      sortable: true,
      sortValue: (r) => r.userName,
      cell: (r) => <span className="text-ink-2">{r.userName}</span>,
    },
    {
      key: 'state',
      header: 'But',
      cell: () => <Badge tone="warning">No longer an active user</Badge>,
    },
  ]
  return (
    <DataTable columns={columns} rows={rows} getRowKey={(r) => `${r.teamId}-${r.userId}`} />
  )
}

type EmptyCrewRow = { teamId: number; teamName: string; reason: string }

export function EmptyCrewTable({ rows }: { rows: EmptyCrewRow[] }) {
  const columns: Column<EmptyCrewRow>[] = [
    {
      key: 'crew',
      header: 'Crew',
      sortable: true,
      sortValue: (r) => r.teamName,
      cell: (r) => <TextLink href="/setup/job-workflow">{r.teamName}</TextLink>,
    },
    {
      key: 'reason',
      header: 'What is wrong',
      sortable: true,
      sortValue: (r) => r.reason,
      cell: (r) => (
        // Nobody leading it still puts people on a job, so it is the milder of
        // the two. Nobody on it does nothing at all.
        <Badge tone={r.reason === 'Nobody is on it' ? 'danger' : 'warning'}>{r.reason}</Badge>
      ),
    },
  ]
  return <DataTable columns={columns} rows={rows} getRowKey={(r) => `${r.teamId}-${r.reason}`} />
}
