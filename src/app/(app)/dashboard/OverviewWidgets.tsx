'use client'

import Link from 'next/link'
import {
  Badge,
  DataTable,
  EmptyState,
  Icons,
  MiniStat,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  type Column,
} from '@/components/ui'
import type {
  AttentionItem,
  CashPosition,
  Pipeline,
  ReorderLine,
  ReorderPanel,
} from '@/lib/site/dashboardOverview'
import { money, count, percent, qty } from './format'

/**
 * The as-at-now widgets.
 *
 * All of these read from `/api/dashboard/overview`, which does not take a date
 * range — see `src/lib/site/dashboardOverview.ts` for why. Each is rendered
 * under an "As at today" badge that SalesDashboard adds from the registry, so
 * nothing here has to remember to say it.
 */

/* ── Needs attention ──────────────────────────────────────────────────────── */

const DOT: Record<AttentionItem['tone'], string> = {
  danger: 'bg-danger',
  warning: 'bg-warning',
}

/**
 * The action list.
 *
 * Every row is a verb: a count, what it is, and a link to the screen that
 * clears it. The count leads because it is what makes a row worth reading, and
 * it is the one figure on this screen allowed to be loud.
 */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Icons.Check size={22} />}
        title="Nothing needs attention"
        hint="No overdue accounts, empty shelves or open tills."
      />
    )
  }

  return (
    <ul className="divide-y divide-border">
      {items.map((item) => (
        <li key={item.key}>
          {/* The count and its label on one line, the money underneath rather
              than beside it. Side by side, the two competed for a narrow card
              and the label — the part that says what the row IS — lost, leaving
              "3 470 accounts ov…" next to an exact figure. The label wins. */}
          <Link
            href={item.href}
            className="group flex items-center gap-2.5 px-4 py-2.5 transition hover:bg-surface-2"
          >
            <span
              className={`size-1.5 shrink-0 rounded-pill ${DOT[item.tone]}`}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="numeric text-sm font-semibold text-ink">
                  {count(item.count)}
                </span>
                <span className="min-w-0 truncate text-sm text-ink-2">{item.label}</span>
              </span>
              {item.amount !== null && (
                <span className="numeric block text-xs text-muted">{money(item.amount)}</span>
              )}
            </span>
            <Icons.ArrowRight
              size={14}
              className="shrink-0 text-faint transition group-hover:text-brand"
            />
          </Link>
        </li>
      ))}
    </ul>
  )
}

/* ── Cash position ────────────────────────────────────────────────────────── */

export function CashPositionPanel({ cash }: { cash: CashPosition }) {
  if (cash.accounts.length === 0) {
    return (
      <EmptyState
        icon={<Icons.Coins size={22} />}
        title="No bank accounts"
        hint="Add one under Setup to see the cash position here."
      />
    )
  }

  return (
    <div className="p-4">
      <SummaryList>
        {cash.accounts.map((account) => (
          <SummaryRow
            key={account.id}
            label={
              <span className="flex items-center gap-2">
                <span className="truncate">{account.name}</span>
                {/* Unreconciled is the only judgement on this panel, so it is
                    the only thing wearing a colour. */}
                {account.unreconciled > 0 && (
                  <Badge tone="warning">{count(account.unreconciled)} to agree</Badge>
                )}
              </span>
            }
            value={<span className="numeric">{money(account.balance)}</span>}
          />
        ))}
        <SummaryTotal label="Total" value={<span className="numeric">{money(cash.total)}</span>} />
      </SummaryList>
    </div>
  )
}

/* ── Pipeline ─────────────────────────────────────────────────────────────── */

/**
 * What has been promised, in both directions, but has not yet landed.
 *
 * Three figures rather than three widgets: individually each is a small number,
 * and together they are one question — what is owed to the shop in work rather
 * than in money.
 */
export function PipelinePanel({ pipeline }: { pipeline: Pipeline }) {
  const empty =
    pipeline.openQuotes === 0 && pipeline.outstandingOrders === 0 && pipeline.activeLaybys === 0

  if (empty) {
    return (
      <EmptyState
        icon={<Icons.FileText size={22} />}
        title="Nothing in the pipeline"
        hint="No open quotes, outstanding orders or active lay-bys."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-3 gap-2">
        <MiniStat
          label="Open quotes"
          value={count(pipeline.openQuotes)}
          tone={pipeline.expiringSoon > 0 ? 'warning' : 'default'}
        />
        <MiniStat label="Orders out" value={count(pipeline.outstandingOrders)} />
        <MiniStat
          label="Lay-bys"
          value={count(pipeline.activeLaybys)}
          tone={pipeline.overdueLaybys > 0 ? 'danger' : 'default'}
        />
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          {pipeline.openQuotes > 0 ? (
            <>
              <span className="numeric text-ink-2">{money(pipeline.openQuoteValue)}</span> quoted
              {pipeline.expiringSoon > 0 && (
                <span className="text-warning-ink">
                  {' '}
                  · {count(pipeline.expiringSoon)} expiring soon
                </span>
              )}
            </>
          ) : (
            'No open quotes'
          )}
        </span>
        <span>
          {/* Null, not zero: no decided quotes is "we cannot say yet", which a
              0% would state as a fact. */}
          {pipeline.conversionRate === null
            ? 'No decided quotes yet'
            : `${percent(pipeline.conversionRate)} converted`}
        </span>
      </div>
    </div>
  )
}

/* ── Reorder ──────────────────────────────────────────────────────────────── */

const REORDER_COLUMNS: readonly Column<ReorderLine>[] = [
  {
    key: 'description',
    header: 'Product',
    cell: (r) => (
      <span className="block truncate font-medium text-ink" title={`${r.code} — ${r.description}`}>
        {r.description}
      </span>
    ),
    sortable: true,
    sortValue: (r) => r.description.toLowerCase(),
  },
  {
    /*
     * On hand AND the minimum in one cell, as "2 / 10".
     *
     * They were separate columns, and at a quarter of the grid the fourth one
     * was clipped off the right edge of the card. The two readings only mean
     * anything together — "two left, against a minimum of ten" — so they share
     * a cell, and the quantity to order keeps the room it needs.
     *
     * Nothing on the shelf is a different problem from merely being low, and
     * the badge is what makes the two tell themselves apart at a glance.
     */
    key: 'stockOnHand',
    header: 'On hand / min',
    numeric: true,
    sortable: true,
    sortValue: (r) => r.stockOnHand,
    cell: (r) => (
      <span className="whitespace-nowrap">
        {r.stockOnHand <= 0 ? (
          <Badge tone="danger">{qty(r.stockOnHand)}</Badge>
        ) : (
          <span className="text-warning-ink">{qty(r.stockOnHand)}</span>
        )}
        <span className="text-faint"> / {qty(r.minStock)}</span>
      </span>
    ),
    width: 'w-28',
  },
  {
    key: 'suggested',
    header: 'Order',
    numeric: true,
    sortable: true,
    sortValue: (r) => r.suggested,
    cell: (r) => <span className="font-medium text-ink">{qty(r.suggested)}</span>,
    width: 'w-16',
  },
]

export function ReorderTable({ reorder }: { reorder: ReorderPanel }) {
  return (
    <DataTable
      columns={REORDER_COLUMNS}
      rows={reorder.rows}
      getRowKey={(r) => r.productId}
      empty={{
        icon: <Icons.Check size={22} />,
        title: 'Nothing below minimum',
        hint: `Every product at ${reorder.locationName} is above its minimum level.`,
      }}
    />
  )
}

/* ── Job cards ────────────────────────────────────────────────────────────── */

/**
 * One job figure, as a KPI tile.
 *
 * Every one of these is a LINK, and that is the requirement rather than a
 * nicety: the PRD says the dashboard figures must be clickable — selecting
 * "Awaiting Parts: 8" opens those eight job cards. A number somebody cannot act
 * on is a number they stop reading.
 */
export function JobStat({
  label,
  value,
  href,
  tone,
}: {
  /**
   * The line UNDER the figure, and deliberately not the widget title.
   *
   * The card header already says "Open jobs"; repeating it here produced
   * "Open jobs / Open / 6", which reads as a stutter. So the header names the
   * subject and this says what the number is OF.
   */
  label: string
  value: number
  href: string
  /** Only for the figures that mean somebody should do something. */
  tone?: 'warning' | 'danger'
}) {
  return (
    <Link
      href={href}
      className="flex h-full flex-col justify-center gap-0.5 px-4 py-3 transition hover:bg-surface-2"
    >
      <span
        className={`numeric text-2xl font-semibold ${
          value > 0 && tone === 'danger'
            ? 'text-danger'
            : value > 0 && tone === 'warning'
              ? 'text-warning'
              : 'text-ink'
        }`}
      >
        {count(value)}
      </span>
      <span className="truncate text-xs text-muted">{label}</span>
    </Link>
  )
}

/**
 * Open jobs split by stage or by person.
 *
 * A bar per row rather than a donut: these are counts a dispatcher compares
 * ("who has the most on"), and a donut answers proportion instead — which is
 * the wrong question when the total is twelve.
 *
 * The bar is scaled against the LARGEST row, not the total, so a split of
 * 5/4/3 reads as three comparable piles instead of three thin slivers.
 */
export function JobSplit({
  rows,
  emptyHint,
}: {
  rows: { label: string; count: number; href: string }[]
  emptyHint: string
}) {
  if (rows.length === 0) {
    return (
      <EmptyState icon={<Icons.Wrench size={22} />} title="No open jobs" hint={emptyHint} />
    )
  }

  const most = Math.max(...rows.map((r) => r.count), 1)

  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.label}>
          <Link
            href={row.href}
            className="group flex items-center gap-3 px-4 py-2 transition hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1">
              <span className="mb-1 flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm text-ink-2">{row.label}</span>
                <span className="numeric text-sm font-semibold text-ink">{count(row.count)}</span>
              </span>
              <span className="block h-1.5 overflow-hidden rounded-pill bg-surface-2">
                <span
                  className="block h-full rounded-pill bg-brand"
                  style={{ width: `${Math.round((row.count / most) * 100)}%` }}
                />
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
