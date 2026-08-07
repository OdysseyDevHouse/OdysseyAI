'use client'

import Link from 'next/link'
import { Badge, ButtonLink, DataTable, Icons, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { SupplierAgingRow } from '@/lib/site/aging'

type Bucket = 'current' | 'd30' | 'd60' | 'd90' | 'd120'

/**
 * The payables table lives on the client so its columns — cell renderers and
 * sort accessors are functions — never cross the server boundary. The rows are
 * plain data; the bucket labels arrive as a prop because their source of truth
 * (`@/lib/site/ledger`) is server-only.
 */
export default function AgeAnalysisTable({
  rows,
  bucketLabels,
  overdueOnly,
  showAllHref,
}: {
  rows: SupplierAgingRow[]
  bucketLabels: Record<Bucket, string>
  overdueOnly: boolean
  showAllHref: string
}) {
  const columns: readonly Column<SupplierAgingRow>[] = [
    {
      key: 'supplier',
      header: 'Supplier',
      sortable: true,
      sortValue: (row) => row.name,
      cell: (row) => (
        <div>
          <Link
            href={`/suppliers/${row.id}?tab=transactions`}
            className="text-brand hover:underline"
          >
            {row.code}
          </Link>
          <div className="text-ink">{row.name}</div>
          {row.status !== 'active' && (
            <span className="mt-1 inline-block">
              <Badge tone={row.status === 'on_hold' ? 'danger' : 'neutral'}>
                {row.status === 'on_hold' ? 'On hold' : row.status}
              </Badge>
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'account',
      header: 'Our account',
      sortable: true,
      sortValue: (row) => row.accountNumber ?? '',
      cell: (row) => (
        <div>
          <div className="text-ink-2">{row.accountNumber ?? '—'}</div>
          {row.contactName && <div className="text-xs text-muted">{row.contactName}</div>}
        </div>
      ),
    },
    bucketColumn('current', bucketLabels.current),
    bucketColumn('d30', bucketLabels.d30),
    bucketColumn('d60', bucketLabels.d60),
    bucketColumn('d90', bucketLabels.d90, 'danger'),
    bucketColumn('d120', bucketLabels.d120, 'danger'),
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      sortable: true,
      sortValue: (row) => row.aging.total,
      cell: (row) => (
        <span className="font-medium text-ink">{formatMoney(row.aging.total)}</span>
      ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      empty={
        overdueOnly
          ? {
              title: 'Nothing is overdue',
              hint: 'No invoice is past its due date — the filter is hiding what is still within terms.',
              action: (
                <ButtonLink href={showAllHref} variant="secondary">
                  Show every balance
                </ButtonLink>
              ),
            }
          : {
              title: 'Nothing owed',
              hint: 'No supplier has an outstanding balance.',
              icon: <Icons.Coins size={28} strokeWidth={1.75} />,
            }
      }
    />
  )
}

/**
 * A bucket column. Colour is reserved for the 90/120 buckets — where supply is
 * actually at risk — and zeroes recede so the eye lands on the money.
 */
function bucketColumn(bucket: Bucket, label: string, tone?: 'danger'): Column<SupplierAgingRow> {
  return {
    key: bucket,
    header: label,
    numeric: true,
    sortable: true,
    sortValue: (row) => row.aging[bucket],
    cell: (row) => {
      const value = row.aging[bucket]
      const colour = value === 0 ? 'text-faint' : tone === 'danger' ? 'text-danger' : 'text-ink-2'
      return <span className={colour}>{formatMoney(value)}</span>
    },
  }
}
