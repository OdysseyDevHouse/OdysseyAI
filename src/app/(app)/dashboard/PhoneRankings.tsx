'use client'

import { useState } from 'react'
import { Badge, Button, EmptyState, Icons, SegmentedControl, Skeleton } from '@/components/ui'
import type { DateRange, DetailDimension, RankedRow } from '@/lib/site/salesDashboard'
import { money, count, percent, qty } from './format'
import { DetailModal } from './DetailModal'

/**
 * Top performers — products, departments and cashiers behind one control.
 *
 * ── WHY THREE PANELS BECAME ONE ─────────────────────────────────────────────
 *
 * On the desktop these are three widgets, and that is right on a grid where all
 * three can be open at once and compared. Stacked on a phone they were three
 * near-identical tables, thirty rows deep in total, and the reader had to
 * scroll past two of them to reach the one they wanted. They answer the same
 * question about three different groupings, which is the definition of a
 * segmented control.
 *
 * ── THE ROW IS A RANKING, NOT A TABLE ROW ───────────────────────────────────
 *
 * A `DataTable` needs four columns to say this, and four columns at 390px is
 * either a horizontal scroll or four columns of truncated text. What a ranked
 * list actually needs is a position, a name, and the figure it is ranked on —
 * so the row leads with its rank and puts the rest on a quiet second line.
 *
 * The margin stays a badge for the reason it is one on the desktop table: it is
 * the only figure here carrying a judgement, and it has to survive being
 * scanned rather than read.
 *
 * ── WHAT ORDER THESE ARE IN ─────────────────────────────────────────────────
 *
 * The server's, unchanged: products by units sold, departments and cashiers by
 * turnover — see DIMENSIONS in salesDashboard.ts. Re-sorting the ten rows that
 * came back would produce a list titled "top by gross profit" whose members
 * were still chosen by units sold, which is a lie a reader has no way to catch.
 * Ranking on another measure needs the server to be asked for it.
 */

const TABS = [
  { value: 'products' as const, label: 'Products' },
  { value: 'departments' as const, label: 'Departments' },
  { value: 'cashiers' as const, label: 'Cashiers' },
]

const EMPTY: Record<DetailDimension, { title: string; hint: string }> = {
  products: {
    title: 'No products sold',
    hint: 'Nothing was rung up in this period. Try a wider one.',
  },
  departments: {
    title: 'No departments sold',
    hint: 'Nothing was rung up in this period. Try a wider one.',
  },
  cashiers: {
    title: 'No sales by cashier',
    hint: 'No finalised sales carry a cashier for this period.',
  },
}

/** Margin as a badge: below zero is a loss, thin is worth a second look. */
function marginTone(value: number): 'danger' | 'warning' | 'success' {
  if (value < 0) return 'danger'
  if (value < 10) return 'warning'
  return 'success'
}

export function PhoneRankings({
  products,
  departments,
  cashiers,
  available,
  range,
  loading,
}: {
  products: RankedRow[]
  departments: RankedRow[]
  cashiers: RankedRow[]
  /**
   * Which of the three this reader may see, in the caller's order.
   *
   * Passed rather than inferred from an empty array, because "no cashier may be
   * shown to you" and "nobody sold anything today" are different facts and only
   * one of them should remove the tab. Inferring would make a quiet Monday look
   * like a permission.
   */
  available: DetailDimension[]
  range: DateRange
  loading: boolean
}) {
  const tabs = TABS.filter((t) => available.includes(t.value))
  const [dimension, setDimension] = useState<DetailDimension>(available[0] ?? 'products')
  const [detail, setDetail] = useState<DetailDimension | null>(null)

  if (tabs.length === 0) return null

  /* A dimension can leave `available` while it is the one being shown — a role
     change lands on the next load, not on a remount. Falling back to the first
     tab beats rendering a list the reader is no longer allowed. */
  const active = available.includes(dimension) ? dimension : (available[0] as DetailDimension)
  const rows = { products, departments, cashiers }[active]

  return (
    <section className="rounded-card border border-border bg-surface">
      <div className="flex flex-col gap-3 border-b border-border p-4">
        <div className="text-sm font-medium text-ink">Top performers</div>
        <SegmentedControl
          options={tabs}
          value={active}
          onChange={setDimension}
          size="touch"
          aria-label="Rank by products, departments or cashiers"
        />
      </div>

      {loading ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icons.BarChart size={22} />}
          title={EMPTY[active].title}
          hint={EMPTY[active].hint}
        />
      ) : (
        <>
          <ol className="divide-y divide-border">
            {rows.map((row, i) => (
              <RankRow key={row.key} row={row} rank={i + 1} dimension={active} />
            ))}
          </ol>

          {/* The tail is usually the reason somebody opens this — what is barely
              moving, who is at the bottom — and the card only ever holds ten. */}
          <div className="border-t border-border p-2">
            <Button
              variant="ghost"
              size="touch"
              className="w-full"
              onClick={() => setDetail(active)}
            >
              Show all {tabs.find((t) => t.value === active)?.label.toLowerCase()}
            </Button>
          </div>
        </>
      )}

      <DetailModal dimension={detail} range={range} onClose={() => setDetail(null)} />
    </section>
  )
}

function RankRow({
  row,
  rank,
  dimension,
}: {
  row: RankedRow
  rank: number
  dimension: DetailDimension
}) {
  /* Products are ranked and understood by units; the other two by money. The
     sub-line leads with whichever one this list is actually about. */
  const lead =
    dimension === 'products'
      ? `${qty(row.qty)} sold`
      : `${count(row.saleCount)} ${row.saleCount === 1 ? 'sale' : 'sales'}`

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      {/* The rank in the margin, quiet: it numbers the list rather than
          competing with the names in it. */}
      <span className="numeric w-4 shrink-0 text-right text-xs text-faint">{rank}</span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{row.label}</span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="numeric text-xs text-muted">{lead}</span>
          <Badge tone={marginTone(row.grossProfitPct)}>{percent(row.grossProfitPct)} GP</Badge>
        </span>
      </span>

      <span className="numeric shrink-0 text-sm font-semibold text-ink">
        {money(row.turnoverIncl)}
      </span>
    </li>
  )
}
