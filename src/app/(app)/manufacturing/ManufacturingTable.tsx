'use client'

import { useRouter } from 'next/navigation'
import { Badge, DataTable, Icons, type Column } from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'

/**
 * The build list.
 *
 * A client component because DataTable is one, and a Column carries `cell` and
 * `sortValue` — functions, which cannot cross the server/client boundary.
 * Defining them on the page fails the render outright, and the failure hides
 * until there is at least one row: an empty list early-returns an EmptyState
 * and never reaches DataTable at all.
 *
 * Seven columns, not twelve. The components, the overhead and the reason a
 * build was cancelled all live on the build's own screen, one click away. A
 * list is for finding the row, not for reading it.
 */

export type BuildRow = {
  id: number
  documentNumber: string | null
  documentDate: string
  productCode: string
  description: string
  qty: number
  status: 'draft' | 'posted' | 'cancelled'
  unitCostExcl: number
  totalCost: number
  toLocationCode: string
}

const STATUS_TONE: Record<BuildRow['status'], 'success' | 'neutral' | 'danger'> = {
  posted: 'success',
  draft: 'neutral',
  cancelled: 'danger',
}

const STATUS_LABEL: Record<BuildRow['status'], string> = {
  posted: 'Posted',
  draft: 'Draft',
  cancelled: 'Unbuilt',
}

export default function ManufacturingTable({ rows }: { rows: BuildRow[] }) {
  const router = useRouter()

  const columns: Column<BuildRow>[] = [
    {
      key: 'number',
      header: 'Number',
      cell: (b) => <span className="text-ink">{b.documentNumber ?? '—'}</span>,
      sortValue: (b) => b.documentNumber ?? '',
    },
    {
      key: 'date',
      header: 'Date',
      cell: (b) => b.documentDate,
      sortValue: (b) => b.documentDate,
    },
    {
      key: 'product',
      header: 'Made',
      // What was built is the reason the row exists, so it reads as one thing:
      // the description with its code underneath rather than two columns the
      // eye has to join up.
      cell: (b) => (
        <span className="flex flex-col">
          <span className="text-ink">{b.description}</span>
          <span className="text-xs text-muted">{b.productCode}</span>
        </span>
      ),
      sortValue: (b) => b.description,
    },
    {
      key: 'qty',
      header: 'Built',
      numeric: true,
      cell: (b) => formatQty(b.qty),
      sortValue: (b) => b.qty,
    },
    {
      key: 'unitCost',
      header: 'Unit cost',
      numeric: true,
      cell: (b) => formatMoney(b.unitCostExcl),
      sortValue: (b) => b.unitCostExcl,
    },
    {
      key: 'totalCost',
      header: 'Total cost',
      numeric: true,
      cell: (b) => formatMoney(b.totalCost),
      sortValue: (b) => b.totalCost,
    },
    {
      key: 'to',
      header: 'Into',
      cell: (b) => <span className="text-ink-2">{b.toLocationCode}</span>,
      sortValue: (b) => b.toLocationCode,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (b) => <Badge tone={STATUS_TONE[b.status]}>{STATUS_LABEL[b.status]}</Badge>,
      sortValue: (b) => b.status,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(b) => b.id}
      onRowClick={(b) => router.push(`/manufacturing/${b.id}`)}
      empty={{
        title: 'Nothing has been built yet',
        hint: 'A build takes the ingredients of a recipe off the shelf and puts the finished item on it, so you can count what you made.',
        icon: <Icons.Factory size={22} />,
      }}
    />
  )
}
