import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne, siteExecute } from '../siteDb'
import type { ReportColumn } from '../reportBuilder/spec'

/**
 * Which columns a report shows, and in what order, decided for the whole store.
 *
 * The reasoning for a second table beside list_columns, and for storing order
 * here when 109 refused to, is in 111_report_columns.sql. What matters here:
 *
 *   - The stored value is an ORDERED array of visible OUTPUT keys —
 *     ReportColumn.key, the string every consumer already keys off. Not
 *     SpecColumn.field, which cannot identify a column when the same field
 *     appears twice under different aggregates.
 *   - Unknown keys are dropped on read, so a renamed catalog field needs no
 *     migration.
 *   - No row means "the report's own columns, in the report's own order".
 *
 * The report id is the resolver's id space: 'sales-by-product' for a built-in,
 * 'saved:12' for a saved one. That is what lets a store reorder a BUILT-IN
 * report without first cloning it into a copy.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * The store's ordered visible set, or null when it has never chosen.
 *
 * Null rather than an empty array, for the same reason listColumnsFor returns
 * null: "the store hid everything" and "the store has not decided" are
 * different questions, and only the first should produce an empty report.
 */
export async function reportColumnsFor(
  siteId: number,
  reportId: string,
  /** Every key the report actually produced. A stored key not in here is dropped. */
  known: readonly string[],
): Promise<string[] | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT columns FROM report_columns WHERE report_id = ?',
    [reportId],
  ).catch(() => null)

  if (!row) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(String(row.columns ?? '[]'))
  } catch {
    // A hand-edited row, or one written by a version that stored something
    // else. The report's own columns are a working report; a broken one is not.
    return null
  }
  if (!Array.isArray(parsed)) return null

  const allowed = new Set(known)
  return parsed.filter((key): key is string => typeof key === 'string' && allowed.has(key))
}

/**
 * Sets the store's columns and their order for one report.
 *
 * Filtered against what the report produced on the way in as well as on the way
 * out — a key that does not exist would sit in the row forever, and a round
 * trip through a client is not a place to trust a string.
 */
export async function setReportColumns(
  siteId: number,
  reportId: string,
  ordered: readonly string[],
  known: readonly string[],
  userId?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = new Set(known)
  const clean = [...new Set(ordered.filter((key) => allowed.has(key)))]

  if (clean.length === 0) {
    return {
      ok: false,
      error: 'Keep at least one column — a report with no columns shows nothing.',
    }
  }

  await siteExecute(
    siteId,
    `INSERT INTO report_columns (report_id, columns, updated_by)
          VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE columns = VALUES(columns), updated_by = VALUES(updated_by)`,
    [reportId, JSON.stringify(clean), userId ?? null],
  )

  return { ok: true }
}

/** Forgets the store's choice, so the report's own columns and order apply. */
export async function clearReportColumns(siteId: number, reportId: string): Promise<void> {
  await siteExecute(siteId, 'DELETE FROM report_columns WHERE report_id = ?', [reportId])
}

/**
 * Applies a stored choice to what the engine produced.
 *
 * ── WHY THIS IS A TRANSFORM ON THE RESULT ────────────────────────────────
 *
 * Every consumer of a report — the grid, the CSV, the spreadsheet, the
 * scheduled email — reads one ordered ReportColumn[]. Filtering and reordering
 * that array is therefore the one change that reaches all four, and a column a
 * store has switched off cannot come back in an export.
 *
 * It runs AFTER the query rather than narrowing it. The saving would be real
 * but the correctness would not: totals are computed over the full column set,
 * a ratio column reads two others to re-derive itself, and a filter may name a
 * column nobody displays. Dropping a column from the SQL would quietly change
 * the figures in the ones that remain.
 *
 * Nothing stored means the report's own columns, untouched.
 */
export function applyStoreColumns(
  columns: readonly ReportColumn[],
  stored: readonly string[] | null,
): ReportColumn[] {
  if (!stored || stored.length === 0) return [...columns]

  const byKey = new Map(columns.map((c) => [c.key, c]))
  const out: ReportColumn[] = []
  for (const key of stored) {
    const col = byKey.get(key)
    if (col) out.push(col)
  }

  // A stored set that matches nothing — every key renamed at once, say — would
  // otherwise render a report with no columns at all. The report's own columns
  // are the safer answer to a choice that no longer means anything.
  return out.length > 0 ? out : [...columns]
}
