import { formatCell } from './format'
import type { ReportColumn } from './spec'

/**
 * How a report's rows become the thing a person actually reads: which bands the
 * rows fall into, and what each band subtotals to.
 *
 * ── WHY THIS IS A MODULE AND NOT PART OF THE GRID ────────────────────────
 *
 * Four things render a report — the grid, the PDF, the spreadsheet and the
 * scheduled email — and they must not be able to disagree. While only a browser
 * ever drew one, this logic could live in ReportGrid and nobody was worse off.
 * A server rendering a report for an email at 06:00 has no component tree, and a
 * second implementation of "how a report is shaped" drifts from the first within
 * a release.
 *
 * That is not hypothetical here. ReportGrid and reportSchedules/send.ts each
 * grew their own totals footer, and they HAVE drifted: the grid learned to put
 * the row count in the first column that is not a total, because a store that
 * reorders its columns can put a money column first; the email still assumes
 * index 0 and loses the count. One module is the fix and the prevention.
 *
 * ── CLIENT-SAFE ──────────────────────────────────────────────────────────
 *
 * No 'server-only', no database import — same rule as ./spec.ts and ./format.ts,
 * and for the same reason. ReportGrid is a client component; if it could not
 * import this, the screen would need its own copy and we are back to two.
 *
 * ── BANDING IS NOT SUMMARISING ───────────────────────────────────────────
 *
 * CustomReportSpec.groupFields is SQL GROUP BY: it collapses many rows into one
 * aggregated row, and it is part of the report's definition. What this module
 * does is BANDING — every detail row stays, and a subtotal is inserted under
 * each run of them. Banding the invoice list by payment type must still show
 * every invoice.
 *
 * The two are independent and may both be on. A report summarised by product can
 * still be banded by department; the group fields simply arrive as ordinary
 * columns, which makes them the most natural things to band by.
 *
 * Banding also happens AFTER the run, like applyStoreColumns and for the same
 * reason: it is a question about presentation, so it must not be able to change
 * a figure. Nothing here composes SQL.
 */

/** A contiguous block of rows under one group value, with its subtotal. */
export interface ReportSection {
  /** The group value labelling the block, or null when the report is unbanded. */
  label: string | null
  rows: Record<string, unknown>[]
  /** Null only when there is nothing to total. */
  subtotal: Record<string, number> | null
}

/** One entry in the Group by picker. */
export interface GroupOption {
  key: string
  label: string
}

/** The label a row with no value falls under. */
const NO_VALUE = '(none)'

/**
 * The columns a report may be banded by.
 *
 * Derived from what the run produced rather than authored per report, which is
 * what lets a built-in, a saved report and one Claude wrote this morning all
 * offer grouping without anyone adding a line to each.
 *
 * The rule is "would banding by this tell you anything":
 *
 *   NUMERIC COLUMNS ARE OUT. A band per distinct turnover figure is one band per
 *   row, and subtotalling a column by itself says nothing. This single check
 *   also removes every aggregate and every calculated column, since specColumns
 *   marks all of them numeric.
 *
 *   DOCUMENT NUMBERS ARE OUT. A document number is unique per row by definition,
 *   so it has the same failure as a money column and is worth naming separately
 *   — it is a text column, and it is the one text column that can never work.
 *
 * What is left is text and dates: department, payment type, customer, cashier,
 * status, the day something happened. Those are the questions people group by.
 */
export function groupOptionsFor(columns: readonly ReportColumn[]): GroupOption[] {
  return columns
    .filter((c) => !c.numeric && c.type !== 'document')
    .map((c) => ({ key: c.key, label: c.label }))
}

/**
 * The store's stored choice, if it still means something.
 *
 * Null — render flat — when nothing is stored, when the key names a column this
 * run did not produce, or when it names one that is no longer bandable. The last
 * two matter more than they look: a column can vanish because the catalog field
 * was renamed, because the store hid it, or because the caller's permissions
 * stripped it. Banding by a column whose values are not on screen would put
 * those values in the band headings instead, which for a permission-stripped
 * column is a leak and for a hidden one is simply confusing.
 */
export function resolveGroupKey(
  stored: string | null,
  columns: readonly ReportColumn[],
): string | null {
  if (!stored) return null
  return groupOptionsFor(columns).some((o) => o.key === stored) ? stored : null
}

/**
 * Split rows into bands and subtotal each one.
 *
 * With no group key the whole report is ONE section with a null label that still
 * carries a subtotal. That is deliberate: it lets every renderer close a table
 * the same way whether or not it is banded, instead of each one growing a
 * special case, and it is what isGrouped() reads to decide whether a closing
 * grand total would be a repeat.
 *
 * Row ORDER IS PRESERVED within a band. The rows arrive sorted — by the spec on
 * the server, by the header the user clicked on the client — and re-sorting here
 * would be a second sort implementation contradicting the first.
 *
 * Band order is alphabetical by label, always, using en-ZA numeric collation so
 * "Till 2" comes before "Till 10". Deliberately not user-controllable: a
 * subtotalled table whose bands are in an arbitrary order cannot be scanned.
 */
export function buildSections(
  rows: readonly Record<string, unknown>[],
  columns: readonly ReportColumn[],
  groupKey: string | null,
): ReportSection[] {
  if (!groupKey) {
    const all = [...rows]
    return [
      {
        label: null,
        rows: all,
        subtotal: all.length > 0 ? computeTotals(all, columns) : null,
      },
    ]
  }

  const column = columns.find((c) => c.key === groupKey)
  const groups = new Map<string, Record<string, unknown>[]>()

  for (const row of rows) {
    const label = bandLabel(row[groupKey], column)
    const bucket = groups.get(label)
    if (bucket) bucket.push(row)
    else groups.set(label, [row])
  }

  return [...groups.keys()]
    .sort((a, b) => a.localeCompare(b, 'en-ZA', { numeric: true, sensitivity: 'base' }))
    .map((label) => {
      const bandRows = groups.get(label)!
      return { label, rows: bandRows, subtotal: computeTotals(bandRows, columns) }
    })
}

/**
 * The heading one row falls under.
 *
 * Formatted through the same formatCell the cell itself uses, so a band is
 * labelled with the string the column shows rather than a raw driver value.
 *
 * A DATETIME BANDS BY ITS DATE. Banding by a timestamp that carries minutes
 * gives one band per row — the same failure as a money column, arrived at less
 * obviously — and "group by date" is what anyone choosing a datetime column
 * means.
 */
function bandLabel(value: unknown, column: ReportColumn | undefined): string {
  if (value === null || value === undefined || value === '') return NO_VALUE
  const type = column?.type === 'datetime' ? 'date' : (column?.type ?? 'text')
  return formatCell(value, type) || NO_VALUE
}

/**
 * Whether these sections are banded at all.
 *
 * The question every renderer asks before drawing a closing grand total: an
 * unbanded table already ended with its own total, so repeating it would print
 * the same figures twice under a different name.
 */
export function isGrouped(sections: readonly ReportSection[]): boolean {
  return sections.length > 1 || (sections.length === 1 && sections[0].label !== null)
}

/**
 * Column totals. A ratio column is re-derived from its summed parts rather than
 * added down the column, for the same reason it is weighted per row: adding
 * percentages produces a number that means nothing.
 *
 * Lives here rather than in ./run.ts — where it was private — because a band
 * subtotal and a grand total have to be the same arithmetic. A second summing
 * loop would add percentages down a weighted column, and the bands would not
 * reconcile with the total under them. run.ts imports it back for the grand
 * total, so there is still exactly one implementation.
 */
export function computeTotals(
  rows: readonly Record<string, unknown>[],
  columns: readonly ReportColumn[],
): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const col of columns) {
    if (!col.total) continue
    if (col.ratio) {
      let num = 0
      let den = 0
      for (const row of rows) {
        num += Number(row[col.ratio.num] ?? 0)
        den += Number(row[col.ratio.den] ?? 0)
      }
      totals[col.key] = den === 0 ? 0 : (num / den) * col.ratio.scale
      continue
    }
    let sum = 0
    for (const row of rows) sum += Number(row[col.key] ?? 0)
    totals[col.key] = sum
  }
  return totals
}

/**
 * The column a table's "N rows" label belongs in: the first that carries no
 * total, so the label never lands on top of a figure.
 *
 * Was index 0 in the grid until a store reordered its columns and put a money
 * column first. Shared so the PDF and the spreadsheet cannot re-learn that the
 * hard way — and so the scheduled email, which still assumes index 0, can be
 * fixed by reading this instead.
 */
export function rowCountKeyFor(columns: readonly ReportColumn[]): string | undefined {
  return columns.find((c) => !c.total)?.key
}
