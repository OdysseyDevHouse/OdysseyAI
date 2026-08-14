import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import {
  validateFieldDef,
  validateFieldValue,
  type CustomFieldEntity,
  type CustomFieldType,
  type FieldDefInput,
} from '../customFieldModel'

/**
 * Fields a business defines for itself.
 *
 * ── THIS MODULE KNOWS NOTHING ABOUT JOBS ───────────────────────────────────
 *
 * Deliberately, and it is the whole reason the module exists rather than three
 * columns on job_cards. The plan warned that a general mechanism built inside job
 * cards ends up job-shaped; the defence is that `entity` is a parameter here,
 * jobs are one caller, and nothing in this file would need editing to serve a
 * fourth entity.
 *
 * ── A VALUE IS NOT A SNAPSHOT ──────────────────────────────────────────────
 *
 * job_card_items copies its template because a signed-off check is evidence. A
 * custom field is the opposite: "warranty expires" is a fact somebody corrects,
 * so a value points at its definition and a rename relabels every value.
 *
 * The consequence that needs guarding is deletion — removing a definition would
 * destroy every value under it — which is why deleteFieldDef refuses while any
 * value exists and offers retirement instead.
 *
 * ── WHY THERE IS NO FOREIGN KEY TO THE RECORD ──────────────────────────────
 *
 * `entity` + `entity_id` is a loose pair, matching activity_log and
 * party_documents. One mechanism serving three record types cannot have three
 * foreign keys, so nothing at the database level stops a value outliving its job.
 * That is what reconcileCustomFields reports.
 */

type Row = RowDataPacket & Record<string, unknown>

export type CustomFieldDef = {
  id: number
  entity: CustomFieldEntity
  code: string
  name: string
  hint: string | null
  fieldType: CustomFieldType
  options: string[]
  unit: string | null
  isRequired: boolean
  isPublic: boolean
  sortOrder: number
  isActive: boolean
  /** How many records carry a value. The delete refusal needs it, so it is read once. */
  valueCount: number
}

export type CustomFieldValue = {
  fieldId: number
  code: string
  name: string
  hint: string | null
  fieldType: CustomFieldType
  options: string[]
  unit: string | null
  isRequired: boolean
  isPublic: boolean
  sortOrder: number
  value: string | null
  setByName: string | null
}

export type FieldResult = { ok: true; id: number } | { ok: false; error: string }
export type FieldActionResult = { ok: true } | { ok: false; error: string }

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * The options JSON, read defensively.
 *
 * mysql2 hands back an already-parsed array for a JSON column, but a row written
 * by hand or by an older driver can be a string. Both are accepted; anything else
 * becomes an empty list rather than throwing, because a broken options blob must
 * not take down the screen that would let somebody fix it.
 */
function readOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((o) => String(o))
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map((o) => String(o)) : []
    } catch {
      return []
    }
  }
  return []
}

function mapDef(r: Row): CustomFieldDef {
  return {
    id: Number(r.id),
    entity: String(r.entity) as CustomFieldEntity,
    code: String(r.code),
    name: String(r.name),
    hint: text(r.hint),
    fieldType: String(r.field_type) as CustomFieldType,
    options: readOptions(r.options),
    unit: text(r.unit),
    isRequired: Number(r.is_required) === 1,
    isPublic: Number(r.is_public) === 1,
    sortOrder: Number(r.sort_order),
    isActive: Number(r.is_active) === 1,
    valueCount: Number(r.value_count ?? 0),
  }
}

/**
 * Every field defined for an entity.
 *
 * Tolerant of a site without migration 127: a record screen must still render on
 * a site mid-migration, and the answer "this record has no custom fields" is
 * correct there rather than a crash.
 */
export async function listFieldDefs(
  siteId: number,
  entity: CustomFieldEntity | null = null,
  includeInactive = false,
): Promise<CustomFieldDef[]> {
  try {
    const where: string[] = []
    const params: unknown[] = []
    if (entity !== null) {
      where.push('d.entity = ?')
      params.push(entity)
    }
    if (!includeInactive) where.push('d.is_active = 1')

    const rows = await siteQuery<Row>(
      siteId,
      `SELECT d.*, (SELECT COUNT(*) FROM custom_field_values v WHERE v.field_id = d.id) AS value_count
         FROM custom_field_defs d
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY d.entity, d.sort_order, d.name`,
      params,
    )
    return rows.map(mapDef)
  } catch {
    return []
  }
}

export async function getFieldDef(siteId: number, id: number): Promise<CustomFieldDef | null> {
  const rows = await listFieldDefs(siteId, null, true)
  return rows.find((d) => d.id === id) ?? null
}

/**
 * Create or update a definition.
 *
 * The CODE is frozen once created, matching job_headlines and job_statuses: a
 * report or an import that names this field names it by code, so a rename must
 * relabel rather than restructure.
 */
export async function saveFieldDef(
  siteId: number,
  actor: Actor,
  input: FieldDefInput & { id: number | null },
): Promise<FieldResult> {
  const problem = validateFieldDef(input)
  if (problem) return { ok: false, error: problem }

  const options =
    input.fieldType === 'list' ? input.options.map((o) => o.trim()).filter(Boolean) : []

  try {
    if (input.id === null) {
      const result = await siteExecute(
        siteId,
        `INSERT INTO custom_field_defs
           (entity, code, name, hint, field_type, options, unit, is_required, is_public,
            sort_order, is_active)
         VALUES (?,?,?,?,?,?,?,?,?,
            COALESCE((SELECT n FROM (SELECT MAX(sort_order) + 10 AS n
                        FROM custom_field_defs WHERE entity = ?) t), 0), ?)`,
        [
          input.entity,
          input.code,
          input.name.trim(),
          text(input.hint),
          input.fieldType,
          options.length ? JSON.stringify(options) : null,
          text(input.unit),
          input.isRequired ? 1 : 0,
          input.isPublic ? 1 : 0,
          input.entity,
          input.isActive ? 1 : 0,
        ],
      )
      const id = Number(result.insertId)
      await logActivity(siteId, actor, {
        entity: 'custom_field',
        entityId: id,
        action: 'created',
        detail: `Added the ${input.entity} field "${input.name.trim()}"`,
      }).catch(() => {})
      return { ok: true, id }
    }

    const existing = await getFieldDef(siteId, input.id)
    if (!existing) return { ok: false, error: 'That field no longer exists.' }

    /*
     * Changing the TYPE of a field that already holds values is refused.
     *
     * The values are text, so nothing would fail at the database — a date field
     * turned into a number would simply start reading "2026-03-01" as not a
     * number and reporting every existing row as invalid. Silently invalidating
     * data somebody entered is worse than refusing, and the way out is a new
     * field, which keeps both the old answers and the new ones readable.
     */
    if (existing.fieldType !== input.fieldType && existing.valueCount > 0) {
      return {
        ok: false,
        error: `${existing.valueCount} record(s) already carry a value for this field, so its type cannot change. Add a new field instead.`,
      }
    }

    await siteExecute(
      siteId,
      `UPDATE custom_field_defs
          SET name = ?, hint = ?, field_type = ?, options = ?, unit = ?,
              is_required = ?, is_public = ?, is_active = ?
        WHERE id = ?`,
      [
        input.name.trim(),
        text(input.hint),
        input.fieldType,
        options.length ? JSON.stringify(options) : null,
        text(input.unit),
        input.isRequired ? 1 : 0,
        input.isPublic ? 1 : 0,
        input.isActive ? 1 : 0,
        input.id,
      ],
    )
    await logActivity(siteId, actor, {
      entity: 'custom_field',
      entityId: input.id,
      action: 'updated',
      detail: `Edited the ${input.entity} field "${input.name.trim()}"`,
    }).catch(() => {})
    return { ok: true, id: input.id }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ER_DUP_ENTRY') {
      return { ok: false, error: `There is already a ${input.entity} field with that code.` }
    }
    if (code === 'ER_NO_SUCH_TABLE') {
      return { ok: false, error: 'Custom fields are not set up on this site yet.' }
    }
    throw error
  }
}

/**
 * Delete a definition.
 *
 * Refused while any record carries a value, and this is the important refusal in
 * the module: the FK cascades, so allowing it would silently destroy every answer
 * anybody ever typed. Retiring is offered instead, which keeps the values
 * readable and takes the field off the forms.
 */
export async function deleteFieldDef(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<FieldActionResult> {
  const def = await getFieldDef(siteId, id)
  if (!def) return { ok: false, error: 'That field no longer exists.' }

  if (def.valueCount > 0) {
    return {
      ok: false,
      error: `${def.valueCount} record(s) carry a value for this field. Retire it instead — deleting it would destroy those answers.`,
    }
  }

  await siteExecute(siteId, `DELETE FROM custom_field_defs WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'custom_field',
    entityId: null,
    action: 'deleted',
    detail: `Deleted the ${def.entity} field "${def.name}"`,
  }).catch(() => {})
  return { ok: true }
}

/** Move a field up or down among its siblings. */
export async function moveFieldDef(
  siteId: number,
  actor: Actor,
  id: number,
  direction: 'up' | 'down',
): Promise<FieldActionResult> {
  const def = await getFieldDef(siteId, id)
  if (!def) return { ok: false, error: 'That field no longer exists.' }

  const siblings = (await listFieldDefs(siteId, def.entity, true)).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
  )
  const index = siblings.findIndex((d) => d.id === id)
  const swapWith = direction === 'up' ? siblings[index - 1] : siblings[index + 1]
  if (!swapWith) return { ok: true } // Already at the end. Not an error.

  await siteTransaction(siteId, async (tx) => {
    /*
     * Rewritten by POSITION rather than by swapping the two sort_order values.
     *
     * Two fields created in the same statement can share a sort_order, and
     * swapping equal numbers moves nothing — the arrow then looks broken. Writing
     * the whole list makes the order unambiguous.
     */
    const reordered = [...siblings]
    reordered.splice(index, 1)
    reordered.splice(direction === 'up' ? index - 1 : index + 1, 0, def)
    for (const [position, field] of reordered.entries()) {
      await tx.execute(`UPDATE custom_field_defs SET sort_order = ? WHERE id = ?`, [
        position * 10,
        field.id,
      ])
    }
  })

  return { ok: true }
}

/**
 * Every field for an entity with this record's value filled in.
 *
 * A LEFT JOIN from the definitions, so a record that has never been touched still
 * comes back with the full list of fields to fill in — which is what a form needs.
 */
export async function valuesFor(
  siteId: number,
  entity: CustomFieldEntity,
  entityId: number,
  opts: { publicOnly?: boolean } = {},
): Promise<CustomFieldValue[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT d.id AS field_id, d.code, d.name, d.hint, d.field_type, d.options, d.unit,
              d.is_required, d.is_public, d.sort_order,
              v.value, v.set_by_name
         FROM custom_field_defs d
         LEFT JOIN custom_field_values v
                ON v.field_id = d.id AND v.entity = ? AND v.entity_id = ?
        WHERE d.entity = ? AND d.is_active = 1
          ${opts.publicOnly ? 'AND d.is_public = 1' : ''}
        ORDER BY d.sort_order, d.name`,
      [entity, entityId, entity],
    )
    return rows.map((r) => ({
      fieldId: Number(r.field_id),
      code: String(r.code),
      name: String(r.name),
      hint: text(r.hint),
      fieldType: String(r.field_type) as CustomFieldType,
      options: readOptions(r.options),
      unit: text(r.unit),
      isRequired: Number(r.is_required) === 1,
      isPublic: Number(r.is_public) === 1,
      sortOrder: Number(r.sort_order),
      value: text(r.value),
      setByName: text(r.set_by_name),
    }))
  } catch {
    return []
  }
}

/**
 * Values for MANY records at once, so a list screen is one query.
 *
 * Returns only the records that actually carry a value — a list does not need the
 * empty ones, and returning the full grid for 500 rows would be 500 x every field.
 */
export async function valuesForMany(
  siteId: number,
  entity: CustomFieldEntity,
  entityIds: number[],
): Promise<Map<number, { code: string; name: string; value: string }[]>> {
  const out = new Map<number, { code: string; name: string; value: string }[]>()
  if (entityIds.length === 0) return out
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT v.entity_id, d.code, d.name, v.value
         FROM custom_field_values v
         JOIN custom_field_defs d ON d.id = v.field_id
        WHERE v.entity = ? AND v.entity_id IN (${entityIds.map(() => '?').join(',')})
          AND v.value IS NOT NULL AND v.value <> ''
        ORDER BY d.sort_order, d.name`,
      [entity, ...entityIds],
    )
    for (const r of rows) {
      const id = Number(r.entity_id)
      const list = out.get(id) ?? []
      list.push({ code: String(r.code), name: String(r.name), value: String(r.value) })
      out.set(id, list)
    }
    return out
  } catch {
    return out
  }
}

/**
 * Write the values for one record.
 *
 * Takes the whole set rather than one field at a time: a form saves as a form,
 * and one transaction means a half-saved record cannot exist.
 */
export async function setValues(
  siteId: number,
  actor: Actor,
  entity: CustomFieldEntity,
  entityId: number,
  values: { fieldId: number; value: string | null }[],
): Promise<FieldActionResult> {
  const defs = await listFieldDefs(siteId, entity, false)
  const byId = new Map(defs.map((d) => [d.id, d]))

  // Validated BEFORE anything is written, so a bad value cannot leave half the
  // form saved.
  for (const v of values) {
    const def = byId.get(v.fieldId)
    if (!def) return { ok: false, error: 'One of those fields no longer exists.' }
    const problem = validateFieldValue(def, v.value)
    if (problem) return { ok: false, error: problem }
  }

  try {
    await siteTransaction(siteId, async (tx) => {
      for (const v of values) {
        const clean = v.value === null ? null : v.value.trim()
        if (clean === null || clean === '') {
          /*
           * An emptied field DELETES its row rather than storing an empty string.
           *
           * Otherwise "never answered" and "answered, then cleared" become the
           * same thing on every read, and a required-field check could not tell
           * them apart.
           */
          await tx.execute(
            `DELETE FROM custom_field_values WHERE field_id = ? AND entity = ? AND entity_id = ?`,
            [v.fieldId, entity, entityId],
          )
          continue
        }
        await tx.execute(
          `INSERT INTO custom_field_values
             (field_id, entity, entity_id, value, set_by_user_id, set_by_name)
           VALUES (?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             value = VALUES(value),
             set_by_user_id = VALUES(set_by_user_id),
             set_by_name = VALUES(set_by_name)`,
          [v.fieldId, entity, entityId, clean, actor.userId, actor.userName],
        )
      }
    })
    return { ok: true }
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE') {
      return { ok: false, error: 'Custom fields are not set up on this site yet.' }
    }
    throw error
  }
}

/**
 * Which required fields this record has not answered.
 *
 * Returned as names rather than a boolean, so the caller can say WHICH — "this
 * job is missing something" is a message that sends somebody hunting.
 */
export async function missingRequired(
  siteId: number,
  entity: CustomFieldEntity,
  entityId: number,
): Promise<string[]> {
  const values = await valuesFor(siteId, entity, entityId)
  return values
    .filter((v) => v.isRequired && (v.value === null || v.value.trim() === ''))
    .map((v) => v.name)
}

/** Delete every value for a record. For when the record itself is deleted. */
export async function clearValues(
  siteId: number,
  entity: CustomFieldEntity,
  entityId: number,
  tx?: PoolConnection,
): Promise<void> {
  const sql = `DELETE FROM custom_field_values WHERE entity = ? AND entity_id = ?`
  try {
    if (tx) await tx.execute(sql, [entity, entityId])
    else await siteExecute(siteId, sql, [entity, entityId])
  } catch {
    // A site without 127 has nothing to clear.
  }
}

export type CustomFieldDrift = {
  /**
   * A value whose record is gone.
   *
   * There is no FK to protect this — one mechanism serving three entities cannot
   * have three foreign keys — so deleting a job leaves its values behind. They
   * are harmless until an id is reused, which is exactly why they are reported.
   */
  orphaned: { fieldName: string; entity: string; entityId: number; value: string }[]
  /** A value that no longer passes its own field's rules, usually after an edit. */
  invalid: { fieldName: string; entity: string; entityId: number; value: string; why: string }[]
}

/** Reports, never repairs. */
export async function reconcileCustomFields(siteId: number): Promise<CustomFieldDrift> {
  const empty: CustomFieldDrift = { orphaned: [], invalid: [] }
  try {
    /*
     * The record tables, named here and nowhere else.
     *
     * This is the one place the module knows what an entity IS, and it is
     * unavoidable: reporting an orphan means asking whether the record exists.
     * Kept to a lookup table so adding a fourth entity is one line.
     */
    const TABLES: Record<CustomFieldEntity, string> = {
      job: 'job_cards',
      customer: 'customers',
      equipment: 'customer_assets',
    }

    const orphaned: CustomFieldDrift['orphaned'] = []
    for (const [entity, table] of Object.entries(TABLES) as [CustomFieldEntity, string][]) {
      const rows = await siteQuery<Row>(
        siteId,
        `SELECT d.name, v.entity, v.entity_id, v.value
           FROM custom_field_values v
           JOIN custom_field_defs d ON d.id = v.field_id
          WHERE v.entity = ?
            AND v.entity_id NOT IN (SELECT id FROM ${table})
          LIMIT 200`,
        [entity],
      ).catch(() => [] as Row[])
      for (const r of rows) {
        orphaned.push({
          fieldName: String(r.name),
          entity: String(r.entity),
          entityId: Number(r.entity_id),
          value: String(r.value ?? ''),
        })
      }
    }

    // A value that no longer fits its field. Reachable by editing a list field
    // to drop a choice somebody had already picked.
    const invalid: CustomFieldDrift['invalid'] = []
    const defs = await listFieldDefs(siteId, null, true)
    for (const def of defs) {
      if (def.fieldType !== 'list' && def.fieldType !== 'number' && def.fieldType !== 'date') {
        continue
      }
      const rows = await siteQuery<Row>(
        siteId,
        `SELECT entity, entity_id, value FROM custom_field_values
          WHERE field_id = ? AND value IS NOT NULL AND value <> '' LIMIT 200`,
        [def.id],
      )
      for (const r of rows) {
        const why = validateFieldValue(def, String(r.value))
        if (why) {
          invalid.push({
            fieldName: def.name,
            entity: String(r.entity),
            entityId: Number(r.entity_id),
            value: String(r.value),
            why,
          })
        }
      }
    }

    return { orphaned, invalid }
  } catch {
    return empty
  }
}
