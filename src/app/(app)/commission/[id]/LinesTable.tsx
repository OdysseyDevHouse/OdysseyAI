'use client'

import { DataTable, Badge, type Column } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { StatementLine } from '@/lib/site/commissionRuns'

/**
 * The lines behind one person's total — display-only, so DataTable fits.
 * A client file because columns carry cell functions, which the server page
 * cannot pass across the boundary; it hands over plain rows instead.
 */
export function LinesTable({ lines }: { lines: StatementLine[] }) {
  const columns: Column<StatementLine>[] = [
    {
      key: 'date',
      header: 'Date',
      sortable: true,
      sortValue: (l) => l.documentDate ?? '',
      cell: (l) => <span className="text-muted">{l.documentDate}</span>,
    },
    {
      key: 'document',
      header: 'Document',
      sortable: true,
      sortValue: (l) => l.documentNumber ?? '',
      cell: (l) => (
        <div>
          <div className="text-ink-2">{l.documentNumber}</div>
          {l.docType === 'credit_sale' && <Badge tone="danger">Credit</Badge>}
        </div>
      ),
    },
    {
      key: 'item',
      header: 'Item',
      sortable: true,
      sortValue: (l) => l.description ?? '',
      cell: (l) => (
        <div>
          <div className="text-ink-2">{l.description}</div>
          {l.productCode && <div className="text-xs text-muted">{l.productCode}</div>}
        </div>
      ),
    },
    {
      key: 'rule',
      header: 'Rule',
      sortable: true,
      sortValue: (l) => l.ruleName,
      cell: (l) => (
        <div>
          <div className="text-ink-2">{l.ruleName}</div>
          <div className="text-xs text-muted">
            {l.basis === 'gross_profit' ? 'profit' : 'turnover'}
          </div>
        </div>
      ),
    },
    {
      key: 'base',
      header: 'Base',
      numeric: true,
      sortable: true,
      sortValue: (l) => l.baseAmount,
      cell: (l) => formatMoney(l.baseAmount),
    },
    {
      key: 'rate',
      header: 'Rate',
      numeric: true,
      sortable: true,
      sortValue: (l) => l.ratePct,
      cell: (l) => `${l.ratePct}%`,
    },
    {
      key: 'amount',
      header: 'Commission',
      numeric: true,
      sortable: true,
      sortValue: (l) => l.amount,
      cell: (l) => <span className="font-medium text-ink">{formatMoney(l.amount)}</span>,
    },
  ]

  return <DataTable columns={columns} rows={lines} getRowKey={(l) => l.id} />
}
