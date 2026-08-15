import 'server-only'
import { runBuilderSpec, ReportAccessError, type ReportResult, type RunOptions } from './run'
import {
  validateSpec,
  isWeightedPercent,
  type CustomReportSpec,
  type ReportColumn,
} from './spec'
import { getSource, getField } from './catalog'
import type { Capability } from '@/lib/site/permissions'
import type { GroupSite, SiteResult } from '@/lib/groupReporting'
import { perSite } from '@/lib/groupReporting'
import { round } from '@/lib/decimals'

/**
 * Running ONE report spec across every linked store.
 *
 * The engine is single-site by construction — `runBuilderSpec(siteId, …)`, one
 * table in one database — and this does not change that. It runs the same spec
 * against each store unmodified and merges the results, which is the only way
 * that keeps one execution path for every report in the product.
 *
 * ── WHAT CAN AND CANNOT BE MERGED ────────────────────────────────────────────
 *
 * This is the whole design, and it is a matter of arithmetic rather than taste:
 *
 *   sum, count      merge by addition. Two stores' subtotals add up to the
 *                   group's subtotal, always.
 *
 *   avg, min, max   DO NOT. The average of two averages is not the average
 *                   unless both sides had equal counts, and a per-store minimum
 *                   says nothing about the group's. The engine has already
 *                   collapsed these to a single figure by the time they arrive
 *                   here, so the parts needed to redo the work are gone.
 *
 *   top-N per group A per-store top ten is not the group's top ten: an item
 *                   eleventh everywhere and first nowhere can still lead the
 *                   group, and it would have been dropped before this ran.
 *
 *   detail rows     merge fine — they are not aggregated at all — but a row cap
 *                   applied per store means the merged set is not "the first N
 *                   of the group" either.
 *
 * Rather than produce a confidently wrong figure, an unmergeable spec is
 * REFUSED, with a reason the screen can show. A report that quietly lies about
 * a total is worse than one that declines to answer.
 *
 * ── PERMISSIONS ARE PER STORE ────────────────────────────────────────────────
 *
 * A user holds a different role in each shop, so the capability predicate is a
 * FUNCTION OF SITE, not one set. A store where the user may not read the source
 * drops out with a reason rather than contributing an empty column, and a store
 * that hides a column hides it for that store only — which `hiddenColumns`
 * reports, merged across every store that hid something.
 */

/** Why a spec cannot be run across stores, phrased for a person. */
export type MergeRefusal = {
  reason: 'aggregate' | 'top-n'
  message: string
}

export type MultiSiteReportResult = ReportResult & {
  /** Which stores contributed, in column order. */
  sites: { siteId: number; name: string }[]
  /** Stores left out, with why — never silently dropped. */
  failures: { siteId: number; name: string; error: string }[]
  /** Set when the spec was refused; `rows` is then empty. */
  refusal?: MergeRefusal
}

/** The synthetic column naming which store a row came from. */
export const STORE_COLUMN_KEY = '__store'

/**
 * Can this spec be merged across stores, and if not, why not?
 *
 * Exported and pure so the builder can grey out the toggle with the reason
 * BEFORE anyone runs anything — finding out after a thirty-second query that
 * the answer is "no" is a poor way to learn it.
 */
export function mergeRefusalFor(spec: CustomReportSpec): MergeRefusal | null {
  const source = getSource(spec.source)

  /*
   * A WEIGHTED percentage is the exception that survives.
   *
   * `avg` on a percent field with a ratio is not really an average — the engine
   * emits it as a summed numerator and denominator (`__num`/`__den`) and divides
   * at the end, and `finaliseDerived` leaves both parts on the row. So the parts
   * are still there to be re-summed and re-divided across stores, which is the
   * correct group figure rather than an average of averages.
   *
   * A plain `avg` has no such parts and genuinely cannot be merged.
   */
  const unmergeable = spec.columns.filter((c) => {
    if (c.agg === 'min' || c.agg === 'max') return true
    if (c.agg !== 'avg') return false
    if (c.calc) return false
    const field = source ? getField(source, c.field) : undefined
    return !(field && isWeightedPercent(field, 'avg'))
  })

  if (unmergeable.length > 0) {
    const which = [...new Set(unmergeable.map((c) => c.agg))].join(', ')
    return {
      reason: 'aggregate',
      message:
        `This report uses ${which}, which cannot be combined across stores: an average of ` +
        `per-store averages is not the group's average, and a per-store lowest or highest says ` +
        `nothing about the group's. Change those columns to totals or counts, or run the report ` +
        `one store at a time.`,
    }
  }

  if (spec.topPerGroup && spec.groupFields.length >= 2) {
    return {
      reason: 'top-n',
      message:
        `This report keeps only the top ${spec.topPerGroup} of each group, which cannot be ` +
        `combined across stores: an item that is eleventh at every store and first at none can ` +
        `still lead the group, and it would already have been dropped. Remove the limit to run ` +
        `this across stores.`,
    }
  }

  return null
}

/**
 * Runs a spec against every store and merges the results.
 *
 * `canFor` is asked once per site. A store the user cannot read the source at is
 * reported as a failure with that reason, exactly as an unreachable one is —
 * both mean the same thing to the reader: this store is not in the figures.
 */
export async function runAcrossSites(
  sites: GroupSite[],
  input: CustomReportSpec,
  canFor: (siteId: number) => (c: Capability) => boolean,
  options: RunOptions = {},
): Promise<MultiSiteReportResult> {
  const checked = validateSpec(input)
  if (!checked.ok) throw new Error(checked.error)
  const { spec, source } = checked

  const refusal = mergeRefusalFor(spec)
  const emptyRange = { from: '', to: '' }

  if (refusal) {
    return {
      columns: [], rows: [], totals: {}, range: emptyRange,
      truncated: false, hiddenColumns: [],
      sites: [], failures: [], refusal,
    }
  }

  const results = await perSite(sites, (siteId) =>
    runBuilderSpec(siteId, spec, canFor(siteId), options),
  )

  const ok = results.filter((r): r is SiteResult<ReportResult> & { ok: true } => r.ok)
  const failures = results
    .filter((r): r is SiteResult<ReportResult> & { ok: false } => !r.ok)
    .map((r) => ({
      siteId: r.siteId,
      name: r.name,
      // A permission refusal reads as an error otherwise, and "you do not have
      // access to this data" is a fact about the reader, not a broken store.
      error: r.error,
    }))

  if (ok.length === 0) {
    return {
      columns: [], rows: [], totals: {}, range: emptyRange,
      truncated: false, hiddenColumns: [], sites: [], failures,
    }
  }

  // Every store ran the same spec, so the column set is identical bar what each
  // store's permissions hid. The first store's columns lead; a column hidden
  // everywhere simply never appears.
  const baseColumns = ok[0].data.columns
  const hiddenColumns = [...new Set(ok.flatMap((r) => r.data.hiddenColumns))]
  const range = ok[0].data.range
  const truncated = ok.some((r) => r.data.truncated)

  const summarised = spec.groupFields.length > 0
  const numericKeys = new Set(
    baseColumns.filter((c) => c.numeric && c.total).map((c) => c.key),
  )

  const rows = summarised
    ? mergeGrouped(ok, spec, baseColumns, numericKeys)
    : /* A detail report has no group key to merge on, so rows are concatenated
         and stamped with their store. The row cap was applied per store, which
         `truncated` reports. */
      ok.flatMap((r) =>
        r.data.rows.map((row) => ({ ...row, [STORE_COLUMN_KEY]: r.name })),
      )

  const columns = withStoreColumn(baseColumns, summarised)

  return {
    columns,
    rows,
    totals: computeTotals(rows, columns),
    range,
    truncated,
    hiddenColumns,
    sites: ok.map((r) => ({ siteId: r.siteId, name: r.name })),
    failures,
  }
}

/**
 * Merges grouped rows on their GROUP KEY values.
 *
 * Two stores' "Beverages" rows are the same row of the group report, so their
 * numeric columns add and their group values stay. Anything non-numeric that is
 * not part of the key keeps the first store's value — it cannot be summed, and
 * picking a later one would be equally arbitrary but less predictable.
 */
function mergeGrouped(
  stores: (SiteResult<ReportResult> & { ok: true })[],
  spec: CustomReportSpec,
  columns: ReportColumn[],
  numericKeys: Set<string>,
): Record<string, unknown>[] {
  const keyOf = (row: Record<string, unknown>) =>
    spec.groupFields.map((f) => String(row[f] ?? '')).join(' ')

  const merged = new Map<string, Record<string, unknown>>()

  for (const store of stores) {
    for (const row of store.data.rows) {
      const key = keyOf(row)
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, { ...row })
        continue
      }
      for (const column of columns) {
        if (!numericKeys.has(column.key)) continue
        const a = Number(existing[column.key] ?? 0)
        const b = Number(row[column.key] ?? 0)
        existing[column.key] = round(a + b, 4)
      }
      /* A ratio column is re-derived from its summed parts rather than added —
         two percentages do not add. The parts ride on the row as `__num`/`__den`
         precisely so this stays possible after the fact. */
      for (const column of columns) {
        if (!column.ratio) continue
        const num = Number(existing[column.ratio.num] ?? 0)
        const den = Number(existing[column.ratio.den] ?? 0)
        existing[column.key] = den === 0 ? 0 : round((num / den) * column.ratio.scale, 4)
      }
    }
  }

  return [...merged.values()]
}

/**
 * The store column, prepended for a detail report only.
 *
 * A summarised report has merged its stores together, so a store column would
 * have nothing meaningful to hold — the row IS every store's. A detail report's
 * rows each come from exactly one store, and without this nobody can tell which.
 */
function withStoreColumn(columns: ReportColumn[], summarised: boolean): ReportColumn[] {
  if (summarised) return columns
  return [
    { key: STORE_COLUMN_KEY, label: 'Store', type: 'text', numeric: false, total: false },
    ...columns,
  ]
}

/** Footer figures over the merged set, ratios re-derived rather than added. */
function computeTotals(
  rows: Record<string, unknown>[],
  columns: ReportColumn[],
): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const column of columns) {
    if (!column.total) continue
    if (column.ratio) {
      const num = rows.reduce((t, r) => t + Number(r[column.ratio!.num] ?? 0), 0)
      const den = rows.reduce((t, r) => t + Number(r[column.ratio!.den] ?? 0), 0)
      totals[column.key] = den === 0 ? 0 : round((num / den) * column.ratio.scale, 4)
      continue
    }
    if (!column.numeric) continue
    totals[column.key] = round(
      rows.reduce((t, r) => t + Number(r[column.key] ?? 0), 0),
      4,
    )
  }
  return totals
}

/** Re-exported so callers need not reach past this module for the error type. */
export { ReportAccessError }
