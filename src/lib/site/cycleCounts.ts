import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { nextOccurrence, isDue, type RecurringFrequency } from '../expenseModel'
import { logActivity, type Actor } from './activityLog'
import { createStockTake, todayIso, type StockTakeScope } from './stockTakes'

/**
 * Cycle counting — recurring programmes that generate draft stock takes.
 *
 * The recurrence math is expenseModel's `nextOccurrence`, shared with
 * expenses, contracts and recurring journals: one definition of "the next
 * Monday" across the whole app. Generation is BUTTON-DRIVEN (the recurring
 * journals precedent) and each sheet is an ordinary draft — same grid, same
 * posting, same variance rules — stamped with its programme.
 *
 * THE ONE EXTRA RULE: a programme with an OPEN generated sheet skips instead
 * of piling up. A pile of identical drafts is how the same shelf gets counted
 * against three different snapshots, and posting the previous count is the
 * honest gate on the next one.
 */

type Row = RowDataPacket & Record<string, unknown>

export type CycleProgramme = {
  id: number
  name: string
  locationId: number
  locationName: string
  scope: Exclude<StockTakeScope, 'manual'>
  scopeRefId: number | null
  scopeName: string | null
  includeZeroStock: boolean
  frequency: RecurringFrequency
  dayOfWeek: number | null
  dayOfMonth: number | null
  startsOn: string
  endsOn: string | null
  isActive: boolean
  lastGeneratedFor: string | null
  nextDue: string | null
  /** A generated sheet still draft/counting — the skip reason when present. */
  openTakeId: number | null
  generatedCount: number
}

const SCOPE_NAME_JOIN = `
  LEFT JOIN stock_locations sl ON sl.id = p.location_id
  LEFT JOIN departments d ON p.scope = 'department' AND d.id = p.scope_ref_id
  LEFT JOIN brands b ON p.scope = 'brand' AND b.id = p.scope_ref_id
  LEFT JOIN suppliers s ON p.scope = 'supplier' AND s.id = p.scope_ref_id
`

function mapProgramme(r: Row, asAt: string): CycleProgramme {
  const schedule = {
    frequency: String(r.frequency) as RecurringFrequency,
    dayOfWeek: r.day_of_week === null ? null : Number(r.day_of_week),
    dayOfMonth: r.day_of_month === null ? null : Number(r.day_of_month),
    startsOn: String(r.starts_on),
    endsOn: r.ends_on === null ? null : String(r.ends_on),
    lastGeneratedFor: r.last_generated_for === null ? null : String(r.last_generated_for),
  }
  return {
    id: Number(r.id),
    name: String(r.name),
    locationId: Number(r.location_id),
    locationName: String(r.location_name ?? ''),
    scope: String(r.scope) as Exclude<StockTakeScope, 'manual'>,
    scopeRefId: r.scope_ref_id === null ? null : Number(r.scope_ref_id),
    scopeName: (r.scope_name as string | null) ?? null,
    includeZeroStock: Number(r.include_zero_stock) === 1,
    frequency: schedule.frequency,
    dayOfWeek: schedule.dayOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    startsOn: schedule.startsOn,
    endsOn: schedule.endsOn,
    isActive: Number(r.is_active) === 1,
    lastGeneratedFor: schedule.lastGeneratedFor,
    nextDue: Number(r.is_active) === 1 ? nextOccurrence(schedule, asAt) : null,
    openTakeId: r.open_take_id === null || r.open_take_id === undefined ? null : Number(r.open_take_id),
    generatedCount: Number(r.generated_count ?? 0),
  }
}

export async function listCycleProgrammes(
  siteId: number,
  asAt = todayIso(),
): Promise<CycleProgramme[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.*, sl.name AS location_name,
            COALESCE(d.name, b.name, s.name) AS scope_name,
            (SELECT st.id FROM stock_takes st
              WHERE st.programme_id = p.id AND st.status IN ('draft','counting')
              ORDER BY st.id DESC LIMIT 1) AS open_take_id,
            (SELECT COUNT(*) FROM stock_takes st WHERE st.programme_id = p.id) AS generated_count
       FROM cycle_count_programmes p
       ${SCOPE_NAME_JOIN}
      ORDER BY p.is_active DESC, p.name`,
  )
  return rows.map((r) => mapProgramme(r, asAt))
}

export type SaveProgrammeInput = {
  name: string
  locationId: number
  scope: Exclude<StockTakeScope, 'manual'>
  scopeRefId?: number | null
  includeZeroStock?: boolean
  frequency: RecurringFrequency
  dayOfWeek?: number | null
  dayOfMonth?: number | null
  startsOn: string
  endsOn?: string | null
  isActive?: boolean
}

export type SaveProgrammeResult = { ok: true; id: number } | { ok: false; error: string }

function validateProgramme(input: SaveProgrammeInput): string | null {
  if (!input.name.trim()) return 'Give the programme a name.'
  if (input.scope !== 'full' && !input.scopeRefId) {
    return 'Say which department, brand or supplier the programme counts.'
  }
  if (input.frequency === 'weekly' && (input.dayOfWeek === null || input.dayOfWeek === undefined)) {
    return 'A weekly programme needs a day of the week.'
  }
  if (
    input.frequency !== 'weekly' &&
    (input.dayOfMonth === null || input.dayOfMonth === undefined || input.dayOfMonth < 1 || input.dayOfMonth > 31)
  ) {
    return 'Pick a day of the month, 1 to 31.'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn)) return 'Choose a start date.'
  if (input.endsOn && input.endsOn < input.startsOn) return 'The end date is before the start.'
  return null
}

export async function saveCycleProgramme(
  siteId: number,
  actor: Actor,
  id: number | null,
  input: SaveProgrammeInput,
): Promise<SaveProgrammeResult> {
  const invalid = validateProgramme(input)
  if (invalid) return { ok: false, error: invalid }

  const values = [
    input.name.trim().slice(0, 100),
    input.locationId,
    input.scope,
    input.scope === 'full' ? null : (input.scopeRefId ?? null),
    input.includeZeroStock ? 1 : 0,
    input.frequency,
    input.frequency === 'weekly' ? (input.dayOfWeek ?? 1) : null,
    input.frequency === 'weekly' ? null : (input.dayOfMonth ?? 1),
    input.startsOn,
    input.endsOn ?? null,
    input.isActive === false ? 0 : 1,
  ]

  if (id) {
    await siteExecute(
      siteId,
      `UPDATE cycle_count_programmes
          SET name=?, location_id=?, scope=?, scope_ref_id=?, include_zero_stock=?,
              frequency=?, day_of_week=?, day_of_month=?, starts_on=?, ends_on=?, is_active=?
        WHERE id=?`,
      [...values, id],
    )
    await logActivity(siteId, actor, {
      entity: 'product',
      entityId: id,
      action: 'cycle_programme.update',
      detail: `Cycle count programme — ${input.name}`,
    })
    return { ok: true, id }
  }

  const res = await siteExecute(
    siteId,
    `INSERT INTO cycle_count_programmes
       (name, location_id, scope, scope_ref_id, include_zero_stock,
        frequency, day_of_week, day_of_month, starts_on, ends_on, is_active, user_name)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [...values, actor.userName.slice(0, 120)],
  )
  await logActivity(siteId, actor, {
    entity: 'product',
    entityId: res.insertId,
    action: 'cycle_programme.create',
    detail: `Cycle count programme — ${input.name}`,
  })
  return { ok: true, id: res.insertId }
}

export async function deleteCycleProgramme(siteId: number, actor: Actor, id: number): Promise<void> {
  await siteExecute(siteId, 'DELETE FROM cycle_count_programmes WHERE id = ?', [id])
  await logActivity(siteId, actor, {
    entity: 'product',
    entityId: id,
    action: 'cycle_programme.delete',
    detail: `Cycle count programme #${id} deleted — its past sheets keep reading`,
  })
}

export type GenerateOutcome = {
  generated: { programmeId: number; name: string; stockTakeId: number; forDate: string }[]
  skipped: { programmeId: number; name: string; reason: string }[]
}

/**
 * Generates every draft sheet that is due, catching up missed occurrences.
 *
 * The recurring-journals loop in structure: per programme, guard-bounded
 * catch-up over `nextOccurrence`, stamping `last_generated_for` PER
 * occurrence so a crash mid-way resumes instead of duplicating. A programme
 * whose previous generated sheet is still open skips whole — see the header.
 */
export async function generateDueCycleCounts(
  siteId: number,
  actor: Actor,
  asAt = todayIso(),
): Promise<GenerateOutcome> {
  const programmes = await listCycleProgrammes(siteId, asAt)
  const outcome: GenerateOutcome = { generated: [], skipped: [] }

  for (const programme of programmes) {
    if (!programme.isActive) continue
    if (!isDue(programme, asAt)) continue

    if (programme.openTakeId !== null) {
      outcome.skipped.push({
        programmeId: programme.id,
        name: programme.name,
        reason: 'The previous count for this programme has not been posted.',
      })
      continue
    }

    let last = programme.lastGeneratedFor
    let guard = 0
    while (guard < 24) {
      guard++
      const due = nextOccurrence({ ...programme, lastGeneratedFor: last }, asAt)
      if (!due || due > asAt) break

      const created = await createStockTake(siteId, actor, {
        locationId: programme.locationId,
        documentDate: due,
        scope: programme.scope,
        scopeRefId: programme.scopeRefId,
        includeZeroStock: programme.includeZeroStock,
        programmeId: programme.id,
        reference: programme.name.slice(0, 60),
        note: `Generated by cycle count programme — ${programme.name}`,
      })
      if (!created.ok) {
        // Not stamped, so the failure stays visible and retryable; the
        // open-sheet guard prevents a runaway once one DOES generate.
        outcome.skipped.push({ programmeId: programme.id, name: programme.name, reason: created.error })
        break
      }

      await siteExecute(
        siteId,
        'UPDATE cycle_count_programmes SET last_generated_for = ? WHERE id = ?',
        [due, programme.id],
      )
      last = due
      outcome.generated.push({
        programmeId: programme.id,
        name: programme.name,
        stockTakeId: created.id,
        forDate: due,
      })
      // ONE sheet per generate run per programme — the open-sheet rule makes a
      // second immediately unpostable anyway; the next press catches up.
      break
    }
  }

  if (outcome.generated.length > 0) {
    await logActivity(siteId, actor, {
      entity: 'product',
      entityId: null,
      action: 'cycle_generate',
      detail: `Generated ${outcome.generated.length} cycle count sheet(s)` +
        (outcome.skipped.length ? `, ${outcome.skipped.length} skipped` : ''),
    })
  }
  return outcome
}

/** For the panel: whether the sheet a row points at still exists as a draft. */
export async function programmeOpenSheet(
  siteId: number,
  programmeId: number,
): Promise<number | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM stock_takes WHERE programme_id = ? AND status IN ('draft','counting')
      ORDER BY id DESC LIMIT 1`,
    [programmeId],
  )
  return row ? Number(row.id) : null
}
