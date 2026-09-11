'use client'

import { useState } from 'react'
import { Badge, Card, CardHeader, CardBody, Icons, SegmentedControl } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { PriceHistoryRow } from '@/lib/site/priceHistory'

/**
 * What this product has cost and sold for, and who moved it (144, 256).
 *
 * Read-only — the history is a record, not a control. Every door a price can
 * change through writes it (editor, import, reprice, schedule, revert, fanout,
 * GRV), and since 256 every door a COST changes through does too, so "why did
 * this go out at R75 on Monday" and "why did the margin drop" finally have
 * answers in the same place.
 *
 * ── WHY THE TWO ARE INTERLEAVED AND NOT IN TWO CARDS ────────────────────────
 *
 * They are one story. A supplier puts a cost up, and the shelf price moves to
 * answer it: two rows, usually seconds apart, often from the same GRV. Two
 * cards would make the reader interleave them by timestamp to see that — which
 * is the work this list already does. The filter exists for when only one of
 * the two is being chased.
 */

const SOURCE_TONE: Record<string, 'brand' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  editor: 'brand',
  import: 'neutral',
  reprice: 'warning',
  schedule: 'success',
  revert: 'danger',
  fanout: 'neutral',
  // A cost change from a supplier drove this one, so it reads like a receipt.
  grv: 'brand',
  // Hand-edited, same as the product screen — just from the bulk grid.
  grid: 'brand',
  // Cost-only doors (256).
  derived: 'neutral',
  refer: 'neutral',
  build: 'success',
  transfer: 'neutral',
  unpack: 'neutral',
}

const SOURCE_LABEL: Record<string, string> = {
  editor: 'Edited',
  import: 'Imported',
  reprice: 'Repriced',
  schedule: 'Schedule',
  revert: 'Put back',
  fanout: 'Linked store',
  grv: 'Goods received',
  grid: 'Bulk edit',
  derived: 'From recipe',
  refer: 'Pack ladder',
  build: 'Built',
  transfer: 'Store transfer',
  unpack: 'Pack opened',
}

/** What the figure on this row IS — the left-hand label of the pair. */
function rowLabel(row: PriceHistoryRow): string {
  if (row.kind === 'cost') {
    return row.costColumn === 'average' ? 'Average cost' : 'Last cost'
  }
  return row.structureName ?? 'Price'
}

type Slice = 'all' | 'cost' | 'price'

export default function PriceHistoryPanel({ rows }: { rows: PriceHistoryRow[] }) {
  const [slice, setSlice] = useState<Slice>('all')

  const costCount = rows.filter((r) => r.kind === 'cost').length
  const priceCount = rows.length - costCount

  const shown = slice === 'all' ? rows : rows.filter((r) => r.kind === slice)

  return (
    <Card>
      <CardHeader
        title="Price and cost history"
        description="Every change to what this product costs and what it sells for, whichever door it came through."
        action={
          /* Only offered once there is something to separate. On a product
             whose cost has never moved, a filter with an empty slice behind it
             is a control that can only disappoint. */
          costCount > 0 && priceCount > 0 ? (
            <SegmentedControl
              value={slice}
              onChange={(v) => setSlice(v as Slice)}
              options={[
                { value: 'all', label: 'All' },
                { value: 'cost', label: `Cost (${costCount})` },
                { value: 'price', label: `Price (${priceCount})` },
              ]}
            />
          ) : undefined
        }
      />
      <CardBody>
        {shown.length === 0 ? (
          <p className="text-sm text-muted">
            {rows.length === 0
              ? 'No changes recorded yet — history starts from now.'
              : 'Nothing of that kind yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {shown.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-control border border-border px-3 py-1.5 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-xs text-muted">
                    {row.at.toLocaleDateString('en-ZA')}{' '}
                    {row.at.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {/* Cost rows are marked, price rows are not: a price type's
                      own name already says what it is, and tagging both would
                      put a badge on every line to distinguish half of them. */}
                  {row.kind === 'cost' && <Badge tone="warning">Cost</Badge>}
                  <span className="text-ink-2">{rowLabel(row)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="numeric text-ink">
                    {row.oldPriceIncl !== null && (
                      <>
                        <span className="text-muted line-through">
                          {formatMoney(row.oldPriceIncl)}
                        </span>{' '}
                        <Icons.ChevronRight size={12} className="inline text-faint" />{' '}
                      </>
                    )}
                    {row.newPriceIncl === null ? (
                      <span className="text-danger">removed</span>
                    ) : (
                      <b>{formatMoney(row.newPriceIncl)}</b>
                    )}
                  </span>
                  <Badge tone={SOURCE_TONE[row.source] ?? 'neutral'}>
                    {SOURCE_LABEL[row.source] ?? row.source}
                  </Badge>
                  {row.userName && <span className="text-xs text-muted">{row.userName}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}
