import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne, siteExecute } from '../siteDb'
import type { ReportColumn } from '../reportBuilder/spec'

/**
 * How a report is READ, decided once for the whole store: which columns it
 * shows and in what order, and which column it is banded by.
 *
 * The reasoning for a second table beside list_columns, and for storing order
 * here when 109 refused to, is in 111_report_columns.sql; the reasoning for
 * banding sharing that row rather than getting a table of its own is in
 * 168_report_group_by.sql. What matters here:
 *
 *   - Both stored values are OUTPUT keys — ReportColumn.key, the string every
 *     consumer already keys off. Not SpecColumn.field, which cannot identify a
 *     column when the same field appears twice under different aggregates.
 *   - Unknown keys are dropped on read, so a renamed catalog field needs no
 *     migration.
 *   - No columns row means "the report's own columns, in the report's own
 *     order". No group_by means "flat".
 *
 * The report id is the resolver's id space: 'sales-by-product' for a built-in,
 * 'saved:12' for a saved one. That is what lets a store reorder or band a
 * BUILT-IN report without first cloning it into a copy.
 *
 * The two settings are written independently — each upsert names only its own
 * column — so choosing a grouping never disturbs a column choice, and resetting
 * columns never silently unbands the report.
 */

type Row = RowDataPacket & Record<string, unknown>

/** Both of a store's choices for one report, as stored. */
export interface ReportPrefs {
  /** Raw JSON of the ordered visible keys, or null when never chosen. */
  columns: string | null
  /** A single output key, or null for "no banding". */
  groupBy: string | null
}

/**
 * Both settings in one read.
 *
 * Every caller needs both — the screen, the export route and the scheduled send
 * all render columns AND bands — so fetching them separately would be two round
 * trips for two values that live in the same row.
 */
export async function reportPrefsFor(siteId: number, reportId: string): Promise<ReportPrefs> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT columns, group_by FROM report_columns WHERE report_id = ?',
    [reportId],
  ).catch(() => null)

  if (!row) return { columns: null, groupBy: null }
  return {
    columns: row.columns === null || row.columns === undefined ? null : String(row.columns),
    groupBy: row.group_by === null || row.group_by === undefined ? null : String(row.group_by),
  }
}

/**
 * The stored keys in a prefs row, filtered to what the report actually
 * produced. Split out so a caller holding a ReportPrefs does not have to read
 * the row a second time to parse it.
 */
export function parseStoredColumns(
  stored: string | null,
  known: readonly string[],
): string[] | null {
  if (stored === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
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
  const prefs = await reportPrefsFor(siteId, reportId)
  return parseStoredColumns(prefs.columns, known)
}

/**
 * The column this report is banded by for the store, or null for flat.
 *
 * `known` is the BANDABLE keys — what groupOptionsFor() allowed for this run,
 * not every column. A key that named a column which has since become numeric,
 * been hidden, or been stripped by the caller's permissions therefore resolves
 * to null and the report renders flat, rather than putting values in band
 * headings that the columns no longer show.
 */
export async function reportGroupByFor(
  siteId: number,
  reportId: string,
  known: readonly string[],
): Promise<string | null> {
  const prefs = await reportPrefsFor(siteId, reportId)
  if (!prefs.groupBy) return null
  return known.includes(prefs.groupBy) ? prefs.groupBy : null
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

/**
 * Sets the column this report is banded by for the store. Null means flat.
 *
 * Null is a real choice ("No grouping"), not only an absence — which is why
 * this writes NULL rather than deleting the row: the row may still carry a
 * column choice, and unbanding a report must not throw that away.
 *
 * Filtered against the run's bandable keys on the way in as well as on the way
 * out. A round trip through a client is not a place to trust a string.
 */
export async function setReportGroupBy(
  siteId: number,
  reportId: string,
  key: string | null,
  /** The bandable keys for this run — see groupOptionsFor(). */
  known: readonly string[],
  userId?: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = key && known.includes(key) ? key : null

  if (key && !clean) {
    return { ok: false, error: 'That column cannot be grouped by.' }
  }

  await siteExecute(
    siteId,
    `INSERT INTO report_columns (report_id, group_by, updated_by)
          VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE group_by = VALUES(group_by), updated_by = VALUES(updated_by)`,
    [reportId, clean, userId ?? null],
  )

  return { ok: true }
}

/**
 * Forgets the store's COLUMN choice, so the report's own columns and order
 * apply again.
 *
 * Nulls the column rather than deleting the row, because the row may also carry
 * a grouping and resetting one setting must not silently reset the other. A row
 * left with two nulls is harmless — every read treats it as "nothing chosen".
 */
export async function clearReportColumns(siteId: number, reportId: string): Promise<void> {
  await siteExecute(siteId, 'UPDATE report_columns SET columns = NULL WHERE report_id = ?', [
    reportId,
  ])
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
