import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card } from './Card'
import { Search } from './icons'
import { CONTROL, CONTROL_H } from './styles'

/**
 * The grid a row of StatTiles sits in. One spelling of the strip layout —
 * eleven screens had the same grid classes copy-pasted (some with gap-3, some
 * gap-4). Gutters come from PageBody, not from here.
 */
export function StatStrip({
  children,
  columns = 4,
  className = '',
}: {
  children: ReactNode
  /** Tiles per row at full width. The strip is 2-up on small screens. */
  columns?: 2 | 3 | 4 | 5
  className?: string
}) {
  const cols = {
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
    5: 'sm:grid-cols-2 lg:grid-cols-5',
  }[columns]
  return <div className={`grid grid-cols-2 gap-3 ${cols} ${className}`}>{children}</div>
}

/** A single headline number — takings, stock value, count of something. */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
  iconTone,
  icon,
  href,
}: {
  label: string
  value: string
  hint?: string
  /**
   * Colours the VALUE, and so says the figure itself is an exception — over
   * limit, below minimum, unposted. Leave it `default` for a plain number; a
   * strip where every figure is coloured is a strip with no signal in it.
   */
  tone?: 'default' | 'positive' | 'success' | 'warning' | 'danger'
  /**
   * Colours only the medallion, leaving the value in plain ink. For a tile
   * whose SUBJECT has a natural colour — takings are money, so the glyph is
   * green — where tinting the number would falsely claim the figure needs
   * acting on. Defaults to whatever `tone` is.
   */
  iconTone?: 'default' | 'positive' | 'success' | 'warning' | 'danger'
  /** Glyph in the leading medallion. Keep it to the tile's subject, not decoration. */
  icon?: ReactNode
  /**
   * Makes the whole tile a link — "12 over limit" should go to that filtered
   * list. A figure you cannot drill into is a dead end on a dashboard.
   */
  href?: string
}) {
  const toneClass = {
    default: 'text-ink',
    positive: 'text-success',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone]

  /* The medallion behind the glyph. A `-soft` fill rather than the saturated
     base: it has to sit under an icon at 20px and stay a background, and the
     full-strength tone at that size competes with the figure it labels. */
  const medallionClass = {
    default: 'bg-brand-soft text-brand',
    positive: 'bg-success-soft text-success-ink',
    success: 'bg-success-soft text-success-ink',
    warning: 'bg-warning-soft text-warning-ink',
    danger: 'bg-danger-soft text-danger-ink',
  }[iconTone ?? tone]

  /*
   * Medallion left, figures right, hairline between them.
   *
   * The glyph used to be a faint mark in the corner, which made it decoration —
   * it sat in the tile's quietest spot and named nothing. Leading the row, at
   * the size of the number it introduces, it becomes the tile's subject: the
   * strip is scannable by shape (coins, receipt, clock) before a word is read.
   *
   * The divider is what keeps that from reading as two loose halves; without it
   * the icon floats and the tile looks unfinished at wide column widths.
   */
  const body = (
    <div className="flex items-center gap-3.5">
      {icon && (
        <span
          aria-hidden
          className={`flex size-11 shrink-0 items-center justify-center rounded-pill ${medallionClass}`}
        >
          {icon}
        </span>
      )}
      {icon && <span aria-hidden className="h-9 w-px shrink-0 bg-border" />}
      {/* min-w-0 so a long value truncates inside the tile instead of pushing
          the medallion out of the row. */}
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted">{label}</div>
        <div className={`numeric mt-0.5 truncate text-2xl font-semibold ${toneClass}`}>{value}</div>
        {hint && <div className="mt-0.5 truncate text-xs text-muted">{hint}</div>}
      </div>
    </div>
  )

  if (href) {
    return (
      <Card className="p-0">
        <Link href={href} className="block rounded-card p-4 transition hover:bg-surface-2">
          {body}
        </Link>
      </Card>
    )
  }

  return <Card className="p-4">{body}</Card>
}

/**
 * MiniStat — a compact figure inside other chrome: the three totals above a
 * reconcile table, the parsed/skipped counts on an import review. Where the
 * page's headline numbers belong in a full StatTile strip, these are the
 * working figures a panel keeps at hand.
 */
export function MiniStat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'success' | 'warning' | 'danger'
}) {
  const toneClass = {
    default: 'text-ink',
    success: 'text-success-ink',
    warning: 'text-warning-ink',
    danger: 'text-danger-ink',
  }[tone]
  return (
    <div className="rounded-control bg-surface-2 px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className={`numeric text-sm font-semibold ${toneClass}`}>{value}</div>
    </div>
  )
}

/**
 * Search box that submits on Enter via a plain GET — no client JS needed, so
 * server-rendered list pages can search without becoming Client Components.
 * For a client-side filtered list, use <ToolbarSearch> instead.
 *
 * `keep` matters more than it looks: a GET form submits ONLY its own fields, so
 * without it a search wipes every other filter in the URL. Pass the params the
 * screen wants to survive a search and they ride along as hidden inputs.
 */
export function SearchBar({
  action,
  defaultValue,
  placeholder,
  name = 'q',
  keep,
  className = 'px-6 py-3',
}: {
  action: string
  defaultValue?: string
  placeholder: string
  /** Query key to write. Only change it on a screen with two search boxes. */
  name?: string
  /** Other params to carry through the submit, e.g. `{ status: 'on_hold' }`. */
  keep?: Record<string, string | number | null | undefined>
  /**
   * The form's own padding. The default suits a bar sitting alone under the
   * page header; pass 'p-0' (plus e.g. 'flex-1') when composing it into a
   * TableToolbar that already supplies the spacing.
   */
  className?: string
}) {
  return (
    <form action={action} className={className}>
      {keep &&
        Object.entries(keep).map(([key, value]) =>
          value === null || value === undefined || value === '' ? null : (
            <input key={key} type="hidden" name={key} value={String(value)} />
          ),
        )}
      {/* Same leading-icon treatment as ToolbarSearch, so the two search
          boxes read as one control across server- and client-rendered lists. */}
      <div className="relative max-w-md">
        <Search
          size={16}
          className="pointer-events-none absolute inset-y-0 left-3 my-auto text-faint"
        />
        <input
          type="search"
          name={name}
          defaultValue={defaultValue}
          placeholder={placeholder}
          className={`${CONTROL} ${CONTROL_H} pl-9`}
        />
      </div>
    </form>
  )
}
