import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { parseSpec, type CustomReportSpec } from '../reportBuilder/spec'

/**
 * Saved reports — a report someone BUILT or GENERATED, kept so it can be run
 * again without rebuilding it (and, for an AI-generated one, without paying for
 * another model call).
 *
 * What is stored is the SPEC, never a result. Running it is cheap and
 * deterministic, and a report that showed last month's numbers because that is
 * when it was saved would be worse than no report at all. See the header of
 * sql/site/054_reports.sql for the period trap this avoids.
 *
 * Saved reports are STORE-WIDE: everyone at the site sees them, with
 * created_by kept for provenance only. Access is re-checked on every run
 * against the CALLER's capabilities (see runBuilderSpec), so a saved report can
 * never become a way around them.
 */

export type SavedReportKind = 'builder' | 'ask'

export type SavedReport = {
  id: number
  kind: SavedReportKind
  name: string
  description: string
  /** Null when the stored spec no longer validates against the catalog. */
  spec: CustomReportSpec | null
  question: string
  createdBy: number | null
  createdByName: string
  createdAt: Date
  updatedAt: Date
}

type Row = RowDataPacket & Record<string, unknown>

function mapReport(r: Row): SavedReport {
  return {
    id: Number(r.id),
    kind: String(r.kind) as SavedReportKind,
    name: String(r.name),
    description: String(r.description ?? ''),
    // A spec that no longer parses is surfaced as null rather than thrown:
    // the hub still lists the report so it can be deleted or inspected, which
    // is more useful than a screen that fails to load because of one bad row.
    spec: parseSpec(String(r.spec ?? '')),
    question: String(r.question ?? ''),
    createdBy: r.created_by === null ? null : Number(r.created_by),
    createdByName: String(r.created_by_name ?? ''),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

const COLUMNS = `id, kind, name, description, spec, question,
                 created_by, created_by_name, created_at, updated_at`

export async function listSavedReports(siteId: number): Promise<SavedReport[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM saved_reports ORDER BY updated_at DESC`,
  )
  return rows.map(mapReport)
}

export async function getSavedReport(siteId: number, id: number): Promise<SavedReport | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${COLUMNS} FROM saved_reports WHERE id = ?`,
    [id],
  )
  return row ? mapReport(row) : null
}

export type SaveReportInput = {
  kind: SavedReportKind
  name: string
  description?: string
  spec: CustomReportSpec
  question?: string
  userId: number | null
  userName: string
}

export async function createSavedReport(
  siteId: number,
  input: SaveReportInput,
): Promise<number> {
  const result = await siteExecute(
    siteId,
    `INSERT INTO saved_reports
       (kind, name, description, spec, question, created_by, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.kind,
      input.name.slice(0, 120),
      (input.description ?? '').slice(0, 255),
      JSON.stringify(input.spec),
      (input.question ?? '').slice(0, 500),
      input.userId,
      input.userName.slice(0, 120),
    ],
  )
  return result.insertId
}

export async function updateSavedReport(
  siteId: number,
  id: number,
  changes: { name?: string; description?: string; spec?: CustomReportSpec },
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  if (changes.name !== undefined) {
    sets.push('name = ?')
    params.push(changes.name.slice(0, 120))
  }
  if (changes.description !== undefined) {
    sets.push('description = ?')
    params.push(changes.description.slice(0, 255))
  }
  if (changes.spec !== undefined) {
    sets.push('spec = ?')
    params.push(JSON.stringify(changes.spec))
  }
  if (sets.length === 0) return
  params.push(id)
  await siteExecute(siteId, `UPDATE saved_reports SET ${sets.join(', ')} WHERE id = ?`, params)
}

/**
 * Delete a saved report, and any schedule pointing at it.
 *
 * A schedule whose report is gone would fail every morning forever. Removing
 * them together is the only behaviour that does not leave a rule quietly
 * erroring in the background — and the schedules screen shows what was removed
 * because the caller reports the count.
 */
export async function deleteSavedReport(siteId: number, id: number): Promise<number> {
  const affected = await siteExecute(
    siteId,
    `DELETE FROM report_schedules WHERE report_kind = 'saved' AND saved_report_id = ?`,
    [id],
  )
  await siteExecute(siteId, `DELETE FROM saved_reports WHERE id = ?`, [id])
  return affected.affectedRows
}
