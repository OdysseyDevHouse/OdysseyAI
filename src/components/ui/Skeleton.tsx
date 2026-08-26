import type { ReactNode } from 'react'
import { Card } from './Card'
import { TABLE, TABLE_HEAD_ROW, TABLE_TD, TABLE_TH } from './styles'

/**
 * A shimmering placeholder bar — the atom every skeleton below is built from.
 * Compose into layouts that must not collapse.
 *
 * The fill is `.ody-skel` in globals.css: a pale band that travels left to
 * right across the bar, which is the same family the loaders belong to. Give it
 * a height and width — every caller here does — because the class deliberately
 * sets neither, so one rule can dress a 20px cell bar and a 44px medallion
 * alike. `rounded-control` is the default and any radius in `className`
 * overrides it.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`ody-skel block rounded-control ${className}`} />
}

/*
 * ── WHY THESE ARE COMPONENTS AND NOT A CLASS STRING ───────────────────────
 *
 * A route's `loading.tsx` replaces the WHOLE page — header included, because
 * `children` sits inside <main> in the (app) layout. So every skeleton has to
 * redraw the page header itself, and the first three that did copy-pasted the
 * same flex/border/padding string. Three copies is where a spelling starts to
 * drift from PageHeader's real markup, and a skeleton that is a few pixels off
 * causes exactly the shift it exists to prevent.
 *
 * These mirror PageHeader / StatStrip / TableToolbar one-for-one. If one of
 * those changes shape, change its twin here in the same edit.
 */

/**
 * PageHeader's shape, without the content. Same border, padding and height, so
 * the title row does not move when the real page swaps in.
 *
 * `titleWidth` is a guess at the title's length — a skeleton bar the width of
 * "Products" under a heading that says "Purchase order receipting" is a jump.
 */
export function PageHeaderSkeleton({
  titleWidth = 'w-48',
  action = true,
  back = false,
}: {
  titleWidth?: string
  /** Draw a button-shaped block on the right, for pages with a header action. */
  action?: boolean
  /** Reserve the back arrow's 32px + gap, for detail screens. */
  back?: boolean
}) {
  /*
   * The header's height is set by its TALLEST child, and that depends on
   * whether the page draws an action. Both measured:
   *
   *   · with an action — 73px: 32px padding + the 40px `h-control` button
   *   · without one    — 61px: 32px padding + the 28px <h1> line box
   *
   * So the title bar carries `h-7` (28px) to stand in for the heading, and the
   * action side supplies the extra 12px only when there is genuinely an action.
   * Reserving the control height unconditionally over-reserved on the ~90
   * screens that have no header button.
   */
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
      <div className="flex min-w-0 items-center gap-3">
        {back && <Skeleton className="size-8 shrink-0" />}
        {/* h-7 is the <h1>'s own 28px line box, so an action-less header
            lands at 61px rather than 56px. */}
        <Skeleton className={`h-7 ${titleWidth}`} />
      </div>
      {action && <Skeleton className="h-control w-32" />}
    </div>
  )
}

/**
 * A StatStrip of placeholder tiles at the real tile height.
 *
 * Deliberately draws the medallion: StatTile's icon is 44px and sets the
 * tile's height, so a strip of label+value bars alone would be shorter than
 * the strip that replaces it.
 */
export function StatStripSkeleton({
  tiles = 4,
  columns,
  hint = false,
}: {
  /** How many placeholder tiles to draw — match the real strip exactly. */
  tiles?: number
  /**
   * Tiles per row, mirroring StatStrip's own prop. Defaults to `tiles`, which
   * is right for a single-row strip; pass it explicitly when the page renders
   * MORE tiles than fit one row, so the placeholder wraps onto the same number
   * of rows the real strip does.
   */
  columns?: 2 | 3 | 4 | 5
  /**
   * Reserve StatTile's optional third line. Measured: a tile is 84px without a
   * hint and 102px with one, so guessing costs 18px per strip row.
   */
  hint?: boolean
}) {
  const perRow = columns ?? (Math.min(Math.max(tiles, 2), 5) as 2 | 3 | 4 | 5)
  const cols = {
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
    5: 'sm:grid-cols-2 lg:grid-cols-5',
  }[perRow]
  return (
    <div aria-hidden className={`grid grid-cols-2 gap-3 ${cols}`}>
      {Array.from({ length: tiles }, (_, i) => (
        <Card key={i} className="p-4">
          <div className="flex items-center gap-3.5">
            <Skeleton className="size-11 shrink-0 rounded-pill" />
            <span className="h-9 w-px shrink-0 bg-border" />
            {/* Heights track StatTile's real line boxes — a text-xs label is a
                16px line and a text-2xl value a 32px one — so the tile lands
                at its measured 84px (102px with a hint) rather than 76px. */}
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="mt-0.5 h-8 w-24" />
              {hint && <Skeleton className="mt-0.5 h-4 w-16" />}
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}

/**
 * The toolbar band above a list: filter controls left, actions right.
 *
 * `inCard` matches TableToolbar's own prop — the in-card band carries the rule
 * and `px-4` gutter that lines its controls up with the column headings below.
 */
export function ToolbarSkeleton({
  controls = 2,
  actions = 1,
  inCard = true,
}: {
  controls?: number
  actions?: number
  inCard?: boolean
}) {
  return (
    <div
      aria-hidden
      className={`flex flex-wrap items-center justify-between gap-3 ${
        inCard ? 'border-b border-border px-4 py-3.5' : ''
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* The first control is the search box, which is always the wide one. */}
        {Array.from({ length: controls }, (_, i) => (
          <Skeleton key={i} className={`h-control ${i === 0 ? 'w-64' : 'w-36'}`} />
        ))}
      </div>
      {actions > 0 && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {Array.from({ length: actions }, (_, i) => (
            <Skeleton key={i} className="h-control w-28" />
          ))}
        </div>
      )}
    </div>
  )
}

/** A row of tab labels above a section's content. */
export function TabsSkeleton({ tabs = 4 }: { tabs?: number }) {
  return (
    <div aria-hidden className="flex items-center gap-1 border-b border-border">
      {Array.from({ length: tabs }, (_, i) => (
        <Skeleton key={i} className="mb-2 h-6 w-24" />
      ))}
    </div>
  )
}

/**
 * A stack of SettingRow placeholders — icon tile, label over description, and
 * a control hard right.
 *
 * Mirrors SettingRow's own markup (`px-6 py-4`, a 36px tile, a bottom rule per
 * row bar the last), which is the shape every settings screen in setup/ is
 * built from.
 */
export function SettingRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border px-6 py-4 last:border-b-0"
        >
          <Skeleton className="size-9 shrink-0" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="mt-0.5 h-5 w-72" />
          </div>
          <Skeleton className="h-control w-28 shrink-0" />
        </div>
      ))}
    </div>
  )
}

/**
 * A card of placeholder form fields — label bar over control bar, in the same
 * two-column grid the real forms use.
 */
export function FormSkeleton({ fields = 6, columns = 2 }: { fields?: number; columns?: 1 | 2 }) {
  return (
    <div
      aria-hidden
      className={`grid gap-4 p-4 ${columns === 2 ? 'sm:grid-cols-2' : 'grid-cols-1'}`}
    >
      {Array.from({ length: fields }, (_, i) => (
        <div key={i}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-1.5 h-control w-full" />
        </div>
      ))}
    </div>
  )
}

/**
 * The whole-page wrapper: header, then a PageBody-shaped column.
 *
 * Takes PageBody's exact padding and `gap-5`, so the sections inside line up
 * with the real ones rather than sitting a few pixels off.
 */
export function PageSkeleton({
  children,
  titleWidth,
  action = true,
  back = false,
}: {
  children: ReactNode
  titleWidth?: string
  action?: boolean
  back?: boolean
}) {
  return (
    <>
      <PageHeaderSkeleton titleWidth={titleWidth} action={action} back={back} />
      <div className="flex flex-col gap-5 px-6 pt-5 pb-10">{children}</div>
    </>
  )
}

/**
 * TableSkeleton — a loading table at the real row height (36px), so the page
 * keeps its shape while data loads instead of collapsing to a spinner and
 * shoving everything down when rows arrive (see odyssey-craft on loading).
 *
 * Use inside the same Card the real table will occupy, with the same column
 * count.
 */
export function TableSkeleton({
  columns = 5,
  rows = 8,
  tile = false,
}: {
  columns?: number
  rows?: number
  /**
   * Draw a leading thumbnail in the first cell, for lists that give each row a
   * tile so it can be found by shape (products, customers, staff).
   *
   * Measured: a plain row is 33px, a tiled one 49px. Over ten rows that is
   * 160px of drift — the table's own height, wrong by half a screen.
   */
  tile?: boolean
}) {
  return (
    <div aria-hidden className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            {Array.from({ length: columns }, (_, i) => (
              <th key={i} scope="col" className={TABLE_TH}>
                <Skeleton className="h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className="border-b border-border last:border-b-0">
              {Array.from({ length: columns }, (_, c) => (
                <td key={c} className={TABLE_TD}>
                  {/* h-5 is TABLE_TD's own 20px line box, giving a 33px row. */}
                  {tile && c === 0 ? (
                    <span className="flex items-center gap-2.5">
                      {/* The 36px tile is what makes a tiled row 49px. */}
                      <Skeleton className="size-9 shrink-0" />
                      <Skeleton className="h-5 w-32" />
                    </span>
                  ) : (
                    <Skeleton className={`h-5 ${c === 0 ? 'w-32' : 'w-16'}`} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
