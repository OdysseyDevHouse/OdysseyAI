'use client'

import { DataTable, Icons, type Column } from '@/components/ui'
import { formatCost, formatMoney, formatQty } from '@/lib/decimals'
import type { AdjustmentLine } from '@/lib/site/stockAdjustments'

/**
 * The lines of one adjustment.
 *
 * The signed change is the column everything else supports: it is what moved,
 * and its sign is the whole story. `qtyBefore` sits beside it so the reader can
 * see what was being corrected without opening the product. Reason and note
 * come first, in that order: the code is what the shrinkage report totals, the
 * note is what the person reading that total wants next.
 */
export default function AdjustmentLinesTable({
  lines,
  documentReason,
}: {
  lines: AdjustmentLine[]
  /** Shown on lines that did not override it, so no cell reads as blank. */
  documentReason: string | null
}) {
  const columns: Column<AdjustmentLine>[] = [
    {
      key: 'code',
      header: 'Code',
      cell: (l) => <span className="text-ink-2">{l.productCode ?? '—'}</span>,
      sortValue: (l) => l.productCode ?? '',
    },
    {
      key: 'description',
      header: 'Description',
      cell: (l) => <span className="text-ink">{l.description}</span>,
      sortValue: (l) => l.description,
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (l) =>
        l.reasonName ? (
          <span className="text-ink-2">{l.reasonName}</span>
        ) : (
          <span className="text-muted">{documentReason ?? '—'}</span>
        ),
      sortValue: (l) => l.reasonName ?? documentReason ?? '',
    },
    /*
     * The line's own note, which the reason code cannot carry: a lot number on
     * a recall write-off, a claim reference, which shelf it came off. Sits next
     * to the reason because it elaborates it — and it was being written to the
     * database and shown on no screen, which made a batch write-off's lot
     * identity invisible at exactly the moment someone audits it.
     */
    {
      key: 'note',
      header: 'Note',
      cell: (l) =>
        l.note ? (
          <span className="text-ink-2">{l.note}</span>
        ) : (
          <span className="text-muted">—</span>
        ),
      sortValue: (l) => l.note ?? '',
    },
    {
      key: 'before',
      header: 'Was',
      numeric: true,
      cell: (l) => formatQty(l.qtyBefore),
      sortValue: (l) => l.qtyBefore,
    },
    {
      key: 'change',
      header: 'Change',
      numeric: true,
      cell: (l) => (
        <span className={l.qtyChange < 0 ? 'text-danger-ink' : 'text-success-ink'}>
          {l.qtyChange > 0 ? '+' : ''}
          {formatQty(l.qtyChange)}
        </span>
      ),
      sortValue: (l) => l.qtyChange,
    },
    {
      key: 'after',
      header: 'Became',
      numeric: true,
      cell: (l) => formatQty(l.qtyBefore + l.qtyChange),
      sortValue: (l) => l.qtyBefore + l.qtyChange,
    },
    {
      key: 'cost',
      header: 'Unit cost',
      numeric: true,
      cell: (l) => formatCost(l.unitCostExcl),
      sortValue: (l) => l.unitCostExcl,
    },
    {
      key: 'value',
      header: 'Value',
      numeric: true,
      cell: (l) => (
        <span className={l.qtyChange < 0 ? 'text-danger-ink' : 'text-ink-2'}>
          {formatMoney(l.qtyChange * l.unitCostExcl)}
        </span>
      ),
      sortValue: (l) => l.qtyChange * l.unitCostExcl,
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={lines}
      getRowKey={(l) => l.id}
      empty={{
        title: 'No lines',
        hint: 'This adjustment has nothing on it yet.',
        icon: <Icons.SlidersHorizontal size={22} />,
      }}
    />
  )
}
