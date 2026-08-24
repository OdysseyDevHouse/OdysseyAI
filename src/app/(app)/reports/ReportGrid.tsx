'use client'

import { useMemo, useState, type ReactNode } from 'react'
import {
  EmptyState,
  Icons,
  TABLE_HEAD_ROW,
  TABLE_HEAD_STICKY_INSET,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
  TableScroller,
} from '@/components/ui'
import { formatCell } from '@/lib/reportBuilder/format'
import {
  buildSections,
  isGrouped,
  rowCountKeyFor,
  type ReportSection,
} from '@/lib/reportBuilder/shape'
import { linkKeyFor, type ReportColumn } from '@/lib/reportBuilder/spec'
import { GroupTile, groupStyleFor } from './groupStyle'
import { DocumentCell } from './DocumentCell'

/**
 * The report grid.
 *
 * Hand-built rather than DataTable because the columns are not known until the
 * report runs, and because a report needs a TOTALS row — neither of which
 * DataTable expresses. It wears the shared table skin (TABLE_TH, TABLE_TD, …)
 * so it cannot drift from every other table in the app.
 *
 * Sorting is client-side and deliberately so: the server already capped the
 * rows, they are all in memory, and a round trip to reorder 200 rows someone is
 * staring at feels broken.
 *
 * BANDING comes from lib/reportBuilder/shape.ts rather than being worked out
 * here, so the PDF and the spreadsheet band the same rows the same way and
 * subtotal them with the same arithmetic. Sorting happens FIRST and banding
 * second, so the user's chosen order applies within each band.
 */
export default function ReportGrid({
  columns,
  rows,
  totals,
  emptyHint,
  groupKey = null,
}: {
  columns: ReportColumn[]
  rows: Record<string, unknown>[]
  totals: Record<string, number>
  emptyHint?: string
  /** The store's banding choice. Null renders one flat table, as before. */
  groupKey?: string | null
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = a[sort.key]
      const y = b[sort.key]
      // An empty cell is never the top result, whichever way the column points.
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      if (col?.numeric) return (Number(x) - Number(y)) * dir
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir
    })
  }, [rows, sort, columns])

  // Banded after sorting, so the order the user chose applies inside each band.
  const sections = useMemo(
    () => buildSections(sorted, columns, groupKey),
    [sorted, columns, groupKey],
  )

  /* Resolved for the whole run rather than per band, because each band needs to
     know what the one above it took — see the de-collision note in groupStyle.
     Above the empty-state guard below: a hook may not sit behind a return. */
  const bandStyles = useMemo(() => {
    /* One sequential pass, carrying the accent actually USED by the band above
       — including one that was itself nudged. Recomputing the previous band's
       accent independently would drop that nudge and let a third band collide
       with the second. */
    let previous: string | undefined
    return sections.map((section) => {
      if (section.label === null) return null
      const style = groupStyleFor(section.label, groupKey ?? undefined, previous)
      previous = style.accent
      return style
    })
  }, [sections, groupKey])

  if (columns.length === 0 || rows.length === 0) {
    return (
      <EmptyState
        title="Nothing to report"
        hint={emptyHint ?? 'No records matched this report over the period selected.'}
        icon={<Icons.BarChart size={28} strokeWidth={1.75} />}
      />
    )
  }

  const hasTotals = columns.some((c) => c.total)
  const grouped = isGrouped(sections)

  /*
   * Where the "N rows" label goes: the first column that carries no total.
   *
   * Was `i === 0`, which assumed the leftmost column is never a totalled one.
   * That held while column order came only from the spec, where a grouping or a
   * label leads. It stops holding once a store may reorder its own columns —
   * put a money column first and the row count had nowhere to render, so it
   * silently disappeared. Undefined when every column totals, in which case the
   * footer is all figures and there is nowhere for the label to go anyway.
   *
   * Shared with the PDF and the spreadsheet, so they cannot re-learn this.
   */
  const rowCountKey = rowCountKeyFor(columns)

  function toggleSort(key: string) {
    setSort((s) =>
      s?.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : // Numbers are nearly always wanted biggest-first; text A–Z.
          { key, dir: columns.find((c) => c.key === key)?.numeric ? 'desc' : 'asc' },
    )
  }

  /*
   * A gutter around the whole grid — even on all four sides.
   *
   * The table used to run flush to the card's edge, which put the first column's
   * text hard against the border and the header row's fill into the card's
   * rounded corner. A report is a document — it wants a margin — and this is the
   * one place to set it, so the band washes and the totals rows all stop at the
   * same line.
   *
   * `p-3`, not `px-3 pb-3`: the header row had no gutter above it and so sat
   * hard against the toolbar, which made the top the one edge that did not match
   * the other three.
   *
   * That gutter scrolls WITH the content, which is why the sticky header below
   * sits at `-top-3` rather than `top-0`: at top-0 the 12px gap would stay open
   * above it, showing rows sliding past in the margin. Pulling it up by exactly
   * the gutter parks the header flush against the toolbar.
   */
  return (
    <TableScroller className="p-3">
      <table className="w-full text-sm">
        <thead className={TABLE_HEAD_STICKY_INSET}>
          <tr className={TABLE_HEAD_ROW}>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`${TABLE_TH} ${col.numeric ? TABLE_NUMERIC : ''} whitespace-nowrap`}
                aria-sort={
                  sort?.key === col.key
                    ? sort.dir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
              >
                <button
                  type="button"
                  onClick={() => toggleSort(col.key)}
                  title={col.hint}
                  className={`inline-flex items-center gap-1 hover:text-ink ${
                    col.numeric ? 'flex-row-reverse' : ''
                  }`}
                >
                  {col.label}
                  {sort?.key === col.key ? (
                    sort.dir === 'asc' ? (
                      <Icons.ChevronUp size={13} />
                    ) : (
                      <Icons.ChevronDown size={13} />
                    )
                  ) : (
                    <Icons.SortNeutral size={13} className="text-faint" />
                  )}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map((section, s) => (
            <GroupBlock
              key={section.label ?? `__section_${s}`}
              section={section}
              columns={columns}
              grouped={grouped}
              style={bandStyles[s]}
              rowCountKey={rowCountKey}
            />
          ))}
        </tbody>
        {hasTotals && (
          <tfoot>
            <tr className="border-y-2 border-border bg-surface-2 font-semibold text-ink">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`${TOTALS_TD} ${col.numeric ? TABLE_NUMERIC : ''}`}
                >
                  {col.key === rowCountKey
                    ? // Banded, the closing row is the total OF the bands and
                      // says so; flat, it is the only summary line and the row
                      // count is the more useful thing to put there.
                      grouped
                      ? 'Grand total'
                      : `${rows.length} row${rows.length === 1 ? '' : 's'}`
                    : col.total
                      ? formatCell(totals[col.key], col.type)
                      : ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </TableScroller>
  )
}

/*
 * A totals line is roomier than a data row.
 *
 * TABLE_TD is 36px because rows are scanned hundreds of times; a subtotal is
 * read once per band and is what the eye stops on, so it gets the extra couple
 * of pixels rather than inheriting the density the rows were tuned for.
 */
const TOTALS_TD = 'px-4 py-2 text-ink'

/**
 * One band: its heading, its rows, and the line that closes it.
 *
 * ── COLLAPSING ──────────────────────────────────────────────────────────
 *
 * The triangle folds the band away. While it is folded the band's SUBTOTALS
 * move up onto the heading row, so a fully-collapsed report reads as a
 * one-line-per-band summary — which is the main reason to collapse one in the
 * first place. Expanded, those figures live on the subtotal row instead, so the
 * same numbers are never on screen twice.
 */
/**
 * One data cell.
 *
 * Almost always just the formatted value. The exception is a document number
 * whose column declares what it opens AND whose row carries the record's id —
 * both are required, so a column that is linkable in principle still renders as
 * plain text on a row that has no id to open (an outer join with nothing on the
 * far side, most obviously).
 *
 * Only DATA rows come through here. Totals and subtotals keep calling
 * formatCell directly, and must: an aggregate is many documents at once, so
 * there is no single record for it to lead to.
 */
function Cell({ col, row }: { col: ReportColumn; row: Record<string, unknown> }) {
  const formatted = formatCell(row[col.key], col.type)

  if (col.link) {
    const id = Number(row[linkKeyFor(col.key)])
    if (Number.isFinite(id) && id > 0 && formatted !== '') {
      return <DocumentCell kind={col.link.kind} id={id} label={formatted} />
    }
  }

  const tone = col.tone ? varianceTone(row[col.key]) : null
  if (tone) return <span className={tone}>{formatted}</span>

  return <>{formatted}</>
}

/**
 * Short is red, over is orange, square is green.
 *
 * The asymmetry is the point, and it is how a manager already reads a drawer:
 * short means money is missing and someone must account for it; over is still
 * an error — almost always a mis-key or an uncounted float — but nothing has
 * walked out of the shop. Painting both the same red would bury the one that
 * matters among the ones that do not.
 *
 * A blank cell gets NO colour. An empty variance is "not counted yet", and
 * green there would claim a drawer balanced when nobody has looked at it.
 */
function varianceTone(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  /* Rounded to cents before comparing: the column is DECIMAL(12,4), so a
     rounding tail of a thousandth of a cent would read as "over" and paint a
     balanced drawer orange. */
  const cents = Math.round(n * 100)
  if (cents < 0) return 'font-medium text-danger'
  if (cents > 0) return 'font-medium text-warning'
  return 'text-success'
}

function GroupBlock({
  section,
  columns,
  grouped,
  style,
  rowCountKey,
}: {
  section: ReportSection
  columns: ReportColumn[]
  grouped: boolean
  /** Resolved by the grid, which alone can see the band above. Null when flat. */
  style: { icon: ReactNode; color: string } | null
  rowCountKey: string | undefined
}) {
  const [open, setOpen] = useState(true)
  const label = section.label

  const showHeader = grouped && label !== null && style !== null
  // A row whose group value is empty still forms a band — sales with no payment
  // type recorded are a real answer. Give it a readable name rather than a gap.
  const displayLabel = label === '' ? '(none)' : label
  const subtotal = section.subtotal

  return (
    <>
      {/* Breathing room above each band, so a block (heading → rows → subtotal)
          reads as its own thing rather than as one continuous grid. */}
      {showHeader && (
        <tr aria-hidden>
          <td colSpan={columns.length} className="h-2 border-0 p-0" />
        </tr>
      )}

      {showHeader && (
        <tr
          className="border-y border-border"
          style={{
            /* Mixed from the accent rather than a flat token, so the wash, the
               tile and the count pill are visibly one colour per band. 8% keeps
               it a tint: the rows underneath must stay the thing being read. */
            background: `color-mix(in srgb, ${style.color} 8%, var(--color-surface))`,
          }}
        >
          <td className="whitespace-nowrap px-4 py-3 text-[13px] font-semibold text-ink">
            <div className="flex items-center gap-2.5">
              {/* Chromeless on purpose, like the sort buttons in the header
                  above: the row it sits on is already the affordance, and a
                  bordered control inside a table cell reads as a second table.
                  data-kit-ok — see scripts/check-ui-kit.mjs. */}
              <button
                data-kit-ok
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                title={open ? `Collapse ${displayLabel}` : `Expand ${displayLabel}`}
                className="flex items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <Icons.ChevronDown
                  size={14}
                  className="shrink-0 text-muted transition-transform"
                  style={{ transform: open ? 'none' : 'rotate(-90deg)' }}
                  aria-hidden
                />
                <GroupTile icon={style.icon} color={style.color} />
                <span className="text-[13px] font-semibold text-ink">{displayLabel}</span>
              </button>
              <span
                className="numeric inline-flex items-center rounded-pill px-2 py-px text-[11px] font-semibold"
                style={{
                  color: style.color,
                  background: `color-mix(in srgb, ${style.color} 14%, transparent)`,
                }}
              >
                {section.rows.length.toLocaleString()}
              </span>
            </div>
          </td>

          {/* The band's figures, but only while it is folded — see above. */}
          {columns.slice(1).map((col) => {
            const v = subtotal?.[col.key]
            const show = !open && col.total && v !== null && v !== undefined
            return (
              <td
                key={col.key}
                className={`whitespace-nowrap px-4 py-3 text-[13px] font-semibold text-ink ${
                  col.numeric ? TABLE_NUMERIC : ''
                }`}
              >
                {show ? formatCell(v, col.type) : ''}
              </td>
            )
          })}
        </tr>
      )}

      {open &&
        section.rows.map((row, i) => (
          <tr key={i} className="border-b border-border hover:bg-surface-2">
            {columns.map((col) => (
              <td
                key={col.key}
                className={`${TABLE_TD} ${col.numeric ? TABLE_NUMERIC : ''} ${
                  col.numeric && Number(row[col.key]) < 0 ? 'text-danger' : ''
                }`}
              >
                <Cell col={col} row={row} />
              </td>
            ))}
          </tr>
        ))}

      {/* The line that closes a band, named for the band it closes — "Card
          subtotal" rather than a bare "Total", so a figure read out of context
          still says what it is the total OF. Hidden while collapsed, because
          the heading is carrying those numbers instead. */}
      {open && grouped && subtotal && (
        <tr className="border-y border-border bg-surface-2/60 font-semibold text-ink">
          {columns.map((col) => (
            <td
              key={col.key}
              className={`${TOTALS_TD} ${col.numeric ? TABLE_NUMERIC : ''}`}
            >
              {col.key === rowCountKey
                ? `${displayLabel} subtotal`
                : col.total
                  ? formatCell(subtotal[col.key], col.type)
                  : ''}
            </td>
          ))}
        </tr>
      )}
    </>
  )
}
