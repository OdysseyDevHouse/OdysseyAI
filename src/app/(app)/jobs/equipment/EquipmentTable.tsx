'use client'

import { Badge, DataTable, TextLink, type Column } from '@/components/ui'
import type { CustomerAsset } from '@/lib/site/jobAssets'

/**
 * The equipment list.
 *
 * A client component because DataTable columns carry `cell` and `sortValue`
 * functions, which cannot cross the server boundary — and the failure hides until
 * there is a row, because an empty list early-returns an EmptyState on the page.
 */
export default function EquipmentTable({ rows }: { rows: CustomerAsset[] }) {
  const today = new Date().toISOString().slice(0, 10)

  const columns: Column<CustomerAsset>[] = [
    {
      key: 'asset',
      header: 'Equipment',
      sortable: true,
      sortValue: (r) => r.description,
      cell: (r) => (
        <div className="flex flex-col">
          <TextLink href={`/jobs/equipment/${r.id}`}>{r.description}</TextLink>
          <span className="text-xs text-muted">
            {[r.documentNumber, r.make, r.model].filter(Boolean).join(' · ')}
          </span>
        </div>
      ),
    },
    {
      key: 'serial',
      header: 'Serial',
      sortable: true,
      sortValue: (r) => r.serialText ?? '',
      cell: (r) =>
        r.serialText ? (
          <span className="text-ink-2">{r.serialText}</span>
        ) : (
          // Plenty of equipment has no legible plate — §18.3. Saying so beats a
          // blank cell, which reads as data somebody forgot to enter.
          <span className="text-muted">none on the plate</span>
        ),
    },
    {
      key: 'kind',
      header: 'Kind',
      sortable: true,
      sortValue: (r) => r.assetTypeName ?? '',
      cell: (r) => <span className="text-ink-2">{r.assetTypeName ?? '—'}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      sortable: true,
      sortValue: (r) => r.customerName ?? '',
      cell: (r) =>
        r.customerId === null ? (
          // An asset can exist before anybody claims it — a unit in the workshop.
          <span className="text-muted">unclaimed</span>
        ) : (
          <div className="flex flex-col">
            <TextLink href={`/customers/${r.customerId}`}>{r.customerName}</TextLink>
            {r.serviceAddressName && (
              <span className="text-xs text-muted">{r.serviceAddressName}</span>
            )}
          </div>
        ),
    },
    {
      key: 'warranty',
      header: 'Warranty',
      sortable: true,
      sortValue: (r) => r.warrantyUntil ?? '',
      cell: (r) => {
        if (r.warrantyUntil === null) return <span className="text-muted">—</span>
        // Expired is the thing worth seeing at a glance: it decides who pays.
        return r.warrantyUntil < today ? (
          <span className="text-muted">expired {r.warrantyUntil}</span>
        ) : (
          <Badge tone="success">until {r.warrantyUntil}</Badge>
        )
      },
    },
    {
      key: 'service',
      header: 'Next service',
      sortable: true,
      // Nulls last: on-demand equipment has no next service and belongs below the
      // rows that do, not sorted in among them as if it were overdue.
      sortValue: (r) => r.nextServiceOn ?? '9999-12-31',
      cell: (r) => {
        if (r.nextServiceOn === null) return <span className="text-muted">on demand</span>
        return r.nextServiceOn <= today ? (
          <Badge tone="warning">due {r.nextServiceOn}</Badge>
        ) : (
          <span className="text-ink-2">{r.nextServiceOn}</span>
        )
      },
    },
    {
      key: 'jobs',
      header: 'Jobs',
      numeric: true,
      sortable: true,
      sortValue: (r) => r.jobCount,
      cell: (r) =>
        r.jobCount === 0 ? (
          <span className="text-muted">none yet</span>
        ) : (
          <span className="text-ink-2">{r.jobCount}</span>
        ),
    },
    {
      key: 'state',
      header: '',
      cell: (r) => (r.isActive ? null : <Badge tone="neutral">Retired</Badge>),
    },
  ]

  return <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} />
}
