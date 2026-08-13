'use client'

import { Badge, Card, CardHeader, CardBody, Icons } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { PriceHistoryRow } from '@/lib/site/priceHistory'

/**
 * What this product has sold for, and who moved it (144).
 *
 * Read-only — the history is a record, not a control. Every door a price can
 * change through writes it (editor, import, reprice, schedule, revert,
 * fanout), so "why did this go out at R75 on Monday" finally has an answer.
 */

const SOURCE_TONE: Record<string, 'brand' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  editor: 'brand',
  import: 'neutral',
  reprice: 'warning',
  schedule: 'success',
  revert: 'danger',
  fanout: 'neutral',
}

const SOURCE_LABEL: Record<string, string> = {
  editor: 'Edited',
  import: 'Imported',
  reprice: 'Repriced',
  schedule: 'Schedule',
  revert: 'Put back',
  fanout: 'Linked store',
}

export default function PriceHistoryPanel({ rows }: { rows: PriceHistoryRow[] }) {
  return (
    <Card>
      <CardHeader
        title="Price history"
        description="Every price change on this product, whichever door it came through."
      />
      <CardBody>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No price changes recorded yet — history starts from now.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-control border border-border px-3 py-1.5 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-xs text-muted">
                    {row.at.toLocaleDateString('en-ZA')}{' '}
                    {row.at.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-ink-2">{row.structureName}</span>
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
