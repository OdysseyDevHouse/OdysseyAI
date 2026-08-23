import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import { getSetting } from './settings'
import { toNum } from '../decimals'
import {
  isFormFieldType,
  takesAnswer,
  validateResponse,
  TYPES_WITH_OPTIONS,
  type FormAnswer,
  type FormField,
  type FormFieldType,
  type RecordKind,
} from '../jobFormModel'

/**
 * Building forms, and filling them in (§24).
 *
 * ── PUBLISHING IS WHAT MAKES A VERSION ─────────────────────────────────────
 *
 * A form has one draft version at a time and any number of published ones. The
 * draft may be edited freely; a published version is frozen the moment a
 * response points at it, and editing then starts a new draft.
 *
 * That is the whole versioning story, and it replaces the checklist's
 * copy-on-attach. 114 duplicates every item onto the job so a template edit
 * cannot rewrite signed-off history — correct, but a copy cannot say which
 * version it came from. Here the response NAMES the version, so "every answer
 * to v3" is a query rather than an impossibility.
 *
 * ── A RESPONSE IS A DRAFT UNTIL IT IS SUBMITTED ────────────────────────────
 *
 * §24 asks for draft saving, and the distinction earns its keep at the close
 * gate: a required form half filled in has not been filled in. `submitted_at`
 * NULL is the draft, and `submitForm` is the only thing that sets it — after
 * running the SAME validation the screen ran.
 *
 * ── VALIDATION LIVES IN jobFormModel, NOT HERE ─────────────────────────────
 *
 * Deliberately. The builder screen and the filling-in screen are client
 * components and must be able to check as somebody types; this module is
 * server-only. One pure function called from both is what stops a field having
 * two definitions of valid — the shape documentMath and tenderMath already set.
 */

type Row = RowDataPacket & Record<string, unknown>

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

export type JobForm = {
  id: number
  code: string
  name: string
  description: string | null
  isPublic: boolean
  isActive: boolean
  /** The version people fill in. Null when nothing has been published yet. */
  liveVersionId: number | null
  liveVersion: number
  /** An unpublished version being worked on, if any. */
  draftVersionId: number | null
  responseCount: number
}

export type FormVersion = {
  id: number
  formId: number
  version: number
  isDraft: boolean
  fields: FormField[]
}

export type FormResult = { ok: true; id: number } | { ok: false; error: string }
export type FormActionResult = { ok: true } | { ok: false; error: string }

/* ── Reading ──────────────────────────────────────────────────────────────── */

const SELECT_FORM = `
  SELECT f.id, f.code, f.name, f.description, f.is_public, f.is_active,
         (SELECT v.id FROM job_form_versions v
           WHERE v.form_id = f.id AND v.is_draft = 0
           ORDER BY v.version DESC LIMIT 1) AS live_version_id,
         (SELECT v.version FROM job_form_versions v
           WHERE v.form_id = f.id AND v.is_draft = 0
           ORDER BY v.version DESC LIMIT 1) AS live_version,
         (SELECT v.id FROM job_form_versions v
           WHERE v.form_id = f.id AND v.is_draft = 1 LIMIT 1) AS draft_version_id,
         (SELECT COUNT(*) FROM job_form_responses r WHERE r.form_id = f.id) AS response_count
    FROM job_forms f`

function mapForm(r: Row): JobForm {
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    description: text(r.description),
    isPublic: Number(r.is_public) === 1,
    isActive: Number(r.is_active) === 1,
    liveVersionId: r.live_version_id === null ? null : Number(r.live_version_id),
    liveVersion: r.live_version === null ? 0 : Number(r.live_version),
    draftVersionId: r.draft_version_id === null ? null : Number(r.draft_version_id),
    responseCount: Number(r.response_count ?? 0),
  }
}

export async function listForms(siteId: number, includeRetired = false): Promise<JobForm[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_FORM} ${includeRetired ? '' : 'WHERE f.is_active = 1'} ORDER BY f.name`,
  ).catch(() => [])
  return rows.map(mapForm)
}

export async function getForm(siteId: number, id: number): Promise<JobForm | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_FORM} WHERE f.id = ?`, [id]).catch(() => null)
  return row ? mapForm(row) : null
}

function mapField(r: Row): FormField {
  return {
    id: Number(r.id),
    fieldType: String(r.field_type) as FormFieldType,
    label: String(r.label),
    hint: text(r.hint),
    unit: text(r.unit),
    recordKind: r.record_kind === null ? null : (String(r.record_kind) as RecordKind),
    /*
     * mysql2 hands a JSON column back already parsed, but a site that stored a
     * string into it — or an older row — reads back as text. Handled both ways
     * because a form whose options failed to parse must render as a field with
     * no choices rather than throwing on the screen somebody is filling in.
     */
    options: Array.isArray(r.options)
      ? (r.options as unknown[]).map((o) => String(o))
      : typeof r.options === 'string'
        ? (() => {
            try {
              const parsed: unknown = JSON.parse(r.options as string)
              return Array.isArray(parsed) ? parsed.map((o) => String(o)) : []
            } catch {
              return []
            }
          })()
        : [],
    isRequired: Number(r.is_required) === 1,
    minValue: r.min_value === null ? null : toNum(r.min_value),
    maxValue: r.max_value === null ? null : toNum(r.max_value),
    maxLength: r.max_length === null ? null : Number(r.max_length),
    pattern: text(r.pattern),
    showIfFieldId: r.show_if_field_id === null ? null : Number(r.show_if_field_id),
    showIfValue: r.show_if_value === null ? null : String(r.show_if_value),
    sortOrder: Number(r.sort_order ?? 0),
  }
}

export async function getVersion(siteId: number, versionId: number): Promise<FormVersion | null> {
  const head = await siteQueryOne<Row>(
    siteId,
    `SELECT id, form_id, version, is_draft FROM job_form_versions WHERE id = ?`,
    [versionId],
  ).catch(() => null)
  if (!head) return null

  const fields = await siteQuery<Row>(
    siteId,
    `SELECT * FROM job_form_fields WHERE version_id = ? ORDER BY sort_order, id`,
    [versionId],
  ).catch(() => [])

  return {
    id: Number(head.id),
    formId: Number(head.form_id),
    version: Number(head.version),
    isDraft: Number(head.is_draft) === 1,
    fields: fields.map(mapField),
  }
}

/* ── Building ─────────────────────────────────────────────────────────────── */

export type FieldInput = {
  fieldType: string
  label: string
  hint?: string | null
  unit?: string | null
  recordKind?: string | null
  options?: string[]
  isRequired?: boolean
  minValue?: number | null
  maxValue?: number | null
  maxLength?: number | null
  pattern?: string | null
  /** Index into the SAME input array, not a database id — see saveDraft. */
  showIfIndex?: number | null
  showIfValue?: string | null
}

/** A URL-safe handle, frozen at creation. Same shape jobStatuses uses. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'form'
  )
}

export async function createForm(
  siteId: number,
  actor: Actor,
  input: { name: string; description?: string | null; isPublic?: boolean },
): Promise<FormResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'A form needs a name.' }

  /*
   * The code is unique, and a second "Commissioning report" is an ordinary
   * thing to want. Suffixed rather than refused: the name is what people read,
   * and telling somebody they cannot have it because of a column they have
   * never seen is a refusal with no action attached.
   */
  const base = slugify(name)
  let code = base
  for (let n = 2; n < 100; n++) {
    const clash = await siteQueryOne<Row>(siteId, `SELECT id FROM job_forms WHERE code = ?`, [code])
    if (!clash) break
    code = `${base}_${n}`.slice(0, 60)
  }

  const result = await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO job_forms (name, description, code, is_public) VALUES (?,?,?,?)`,
      [name.slice(0, 190), text(input.description), code, input.isPublic ? 1 : 0] as never,
    )
    const formId = Number((res as { insertId: number }).insertId)

    // Every form starts with an empty draft, so the builder always has
    // something to open. A form with no version at all would need the screen to
    // handle a state that exists for one click.
    await tx.execute(
      `INSERT INTO job_form_versions (form_id, version, is_draft) VALUES (?,1,1)`,
      [formId] as never,
    )
    return formId
  })

  await logActivity(siteId, actor, {
    entity: 'job_form',
    entityId: result,
    action: 'form_created',
    detail: name,
  })
  return { ok: true, id: result }
}

/**
 * Replace the fields on a DRAFT version.
 *
 * Whole-array replace rather than a diff, on the saveLines precedent: the screen
 * sends what the form looks like and the server makes it so. A diff protocol
 * would mean the client tracking which fields it had deleted, which is state a
 * refresh loses.
 *
 * ── WHY CONDITIONS ARE SENT AS INDEXES ─────────────────────────────────────
 *
 * A field's condition points at another field, by id — and on a save that
 * replaces every row, those ids do not exist yet. So the client sends the
 * POSITION of the field it depends on, and this resolves it after the insert.
 * Sending an id would mean the builder could only make a field conditional on
 * one that had already been saved, which is not how anybody builds a form.
 */
export async function saveDraft(
  siteId: number,
  actor: Actor,
  versionId: number,
  fields: readonly FieldInput[],
): Promise<FormActionResult> {
  const version = await siteQueryOne<Row>(
    siteId,
    `SELECT v.id, v.form_id, v.is_draft, f.name
       FROM job_form_versions v JOIN job_forms f ON f.id = v.form_id
      WHERE v.id = ?`,
    [versionId],
  )
  if (!version) return { ok: false, error: 'That version no longer exists.' }
  if (Number(version.is_draft) !== 1) {
    return {
      ok: false,
      error: 'That version has been published. Start a new draft to change it.',
    }
  }

  for (const [i, f] of fields.entries()) {
    if (!isFormFieldType(f.fieldType)) {
      return { ok: false, error: `Field ${i + 1} has a kind this system does not know.` }
    }
    if (!f.label.trim()) return { ok: false, error: `Field ${i + 1} needs a label.` }
    if (
      TYPES_WITH_OPTIONS.includes(f.fieldType as FormFieldType) &&
      (f.options ?? []).filter((o) => o.trim() !== '').length === 0
    ) {
      return { ok: false, error: `${f.label.trim()} is a list, so it needs some choices.` }
    }
    /*
     * A condition may only point BACKWARDS. Forwards would let two fields hide
     * each other, and a form where nothing can ever be shown is one nobody can
     * debug from the screen.
     */
    if (f.showIfIndex !== null && f.showIfIndex !== undefined) {
      if (f.showIfIndex < 0 || f.showIfIndex >= i) {
        return {
          ok: false,
          error: `${f.label.trim()} can only depend on a field above it.`,
        }
      }
    }
  }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(`DELETE FROM job_form_fields WHERE version_id = ?`, [versionId] as never)

    const ids: number[] = []
    for (const [i, f] of fields.entries()) {
      const [res] = await tx.execute(
        `INSERT INTO job_form_fields
           (version_id, field_type, label, hint, unit, record_kind, options, is_required,
            min_value, max_value, max_length, pattern, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          versionId,
          f.fieldType,
          f.label.trim().slice(0, 190),
          text(f.hint),
          text(f.unit),
          text(f.recordKind),
          TYPES_WITH_OPTIONS.includes(f.fieldType as FormFieldType)
            ? JSON.stringify((f.options ?? []).map((o) => o.trim()).filter(Boolean))
            : null,
          f.isRequired ? 1 : 0,
          f.minValue ?? null,
          f.maxValue ?? null,
          f.maxLength ?? null,
          text(f.pattern),
          i,
        ] as never,
      )
      ids.push(Number((res as { insertId: number }).insertId))
    }

    // Second pass: now every field has an id, the conditions can point at one.
    for (const [i, f] of fields.entries()) {
      if (f.showIfIndex === null || f.showIfIndex === undefined) continue
      await tx.execute(
        `UPDATE job_form_fields SET show_if_field_id = ?, show_if_value = ? WHERE id = ?`,
        [ids[f.showIfIndex], text(f.showIfValue), ids[i]] as never,
      )
    }
  })

  await logActivity(siteId, actor, {
    entity: 'job_form',
    entityId: Number(version.form_id),
    action: 'form_draft_saved',
    detail: `${String(version.name)}: ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}`,
  })
  return { ok: true }
}

/**
 * Freeze the draft so it can be filled in.
 *
 * Publishing is what makes a version answerable. Until then it has no fields
 * anybody has agreed to and no response may point at it.
 */
export async function publishVersion(
  siteId: number,
  actor: Actor,
  versionId: number,
): Promise<FormActionResult> {
  const version = await siteQueryOne<Row>(
    siteId,
    `SELECT v.id, v.form_id, v.version, v.is_draft, f.name,
            (SELECT COUNT(*) FROM job_form_fields x WHERE x.version_id = v.id) AS field_count
       FROM job_form_versions v JOIN job_forms f ON f.id = v.form_id
      WHERE v.id = ?`,
    [versionId],
  )
  if (!version) return { ok: false, error: 'That version no longer exists.' }
  if (Number(version.is_draft) !== 1) return { ok: false, error: 'That version is already published.' }
  if (Number(version.field_count) === 0) {
    return { ok: false, error: 'A form with no fields has nothing to fill in.' }
  }

  await siteExecute(
    siteId,
    `UPDATE job_form_versions
        SET is_draft = 0, published_at = NOW(), published_by_name = ?
      WHERE id = ?`,
    [actor.userName.slice(0, 120), versionId],
  )

  await logActivity(siteId, actor, {
    entity: 'job_form',
    entityId: Number(version.form_id),
    action: 'form_published',
    detail: `${String(version.name)} v${Number(version.version)}`,
  })
  return { ok: true }
}

/**
 * Start editing a published form: copy its live version into a new draft.
 *
 * Copied rather than edited, which is the rule the whole file turns on. A
 * published version has responses pointing at it, and §24 is explicit that
 * template edits must not alter historical submissions. Nothing here ever
 * touches a version that is not a draft.
 */
export async function startDraft(
  siteId: number,
  actor: Actor,
  formId: number,
): Promise<FormResult> {
  const form = await getForm(siteId, formId)
  if (!form) return { ok: false, error: 'That form no longer exists.' }
  if (form.draftVersionId !== null) return { ok: true, id: form.draftVersionId }
  if (form.liveVersionId === null) {
    return { ok: false, error: 'That form has nothing published to copy.' }
  }

  const draftId = await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO job_form_versions (form_id, version, is_draft)
       VALUES (?, (SELECT COALESCE(MAX(v.version),0) + 1 FROM job_form_versions v WHERE v.form_id = ?), 1)`,
      [formId, formId] as never,
    )
    const newId = Number((res as { insertId: number }).insertId)

    /*
     * Fields copied in one INSERT..SELECT, and the conditions repaired after.
     *
     * show_if_field_id points at a row in the OLD version, so a straight copy
     * would leave every condition on the new draft pointing back at the
     * published one — editing a field there would silently change what the
     * published version shows. Matched by sort_order, which is what identifies
     * the same field across a copy.
     */
    await tx.execute(
      `INSERT INTO job_form_fields
         (version_id, field_type, label, hint, unit, record_kind, options, is_required,
          min_value, max_value, max_length, pattern, show_if_value, sort_order)
       SELECT ?, field_type, label, hint, unit, record_kind, options, is_required,
              min_value, max_value, max_length, pattern, show_if_value, sort_order
         FROM job_form_fields WHERE version_id = ? ORDER BY sort_order, id`,
      [newId, form.liveVersionId] as never,
    )

    await tx.execute(
      `UPDATE job_form_fields nf
         JOIN job_form_fields old  ON old.version_id = ? AND old.sort_order = nf.sort_order
         JOIN job_form_fields oldt ON oldt.id = old.show_if_field_id
         JOIN job_form_fields newt ON newt.version_id = nf.version_id
                                  AND newt.sort_order = oldt.sort_order
          SET nf.show_if_field_id = newt.id
        WHERE nf.version_id = ?`,
      [form.liveVersionId, newId] as never,
    )

    return newId
  })

  await logActivity(siteId, actor, {
    entity: 'job_form',
    entityId: formId,
    action: 'form_draft_started',
    detail: form.name,
  })
  return { ok: true, id: draftId }
}

/**
 * Retire a form, or bring it back.
 *
 * Never deleted while a response exists — the foreign key on job_form_responses
 * is RESTRICT for exactly this reason. A submitted response is evidence, and a
 * form disappearing would take somebody's answers with it.
 */
export async function setFormActive(
  siteId: number,
  actor: Actor,
  formId: number,
  isActive: boolean,
): Promise<FormActionResult> {
  const form = await getForm(siteId, formId)
  if (!form) return { ok: false, error: 'That form no longer exists.' }

  await siteExecute(siteId, `UPDATE job_forms SET is_active = ? WHERE id = ?`, [
    isActive ? 1 : 0,
    formId,
  ])
  await logActivity(siteId, actor, {
    entity: 'job_form',
    entityId: formId,
    action: isActive ? 'form_restored' : 'form_retired',
    detail: form.name,
  })
  return { ok: true }
}

/* ── Attaching ────────────────────────────────────────────────────────────── */

export async function setHeadlineForms(
  siteId: number,
  headlineId: number,
  forms: readonly { formId: number; isRequired: boolean }[],
): Promise<FormActionResult> {
  await siteTransaction(siteId, async (tx) => {
    await tx.execute(`DELETE FROM job_headline_forms WHERE headline_id = ?`, [headlineId] as never)
    for (const [i, f] of forms.entries()) {
      await tx.execute(
        `INSERT INTO job_headline_forms (headline_id, form_id, is_required, sort_order)
         VALUES (?,?,?,?)`,
        [headlineId, f.formId, f.isRequired ? 1 : 0, i] as never,
      )
    }
  })
  return { ok: true }
}

/* ── Filling in ───────────────────────────────────────────────────────────── */

export type JobFormEntry = {
  formId: number
  formName: string
  isRequired: boolean
  isPublic: boolean
  versionId: number | null
  version: number
  /** The response on this job, if one has been started. */
  responseId: number | null
  submittedAt: Date | null
  respondentName: string
}

/**
 * Every form this job is asked to complete, and where each has got to.
 *
 * Driven by the HEADLINES on the job rather than by copied rows — the
 * attachment is a rule, and the response is the record. Adding a headline
 * therefore adds its forms to a job already in flight, which is what somebody
 * expects when they realise halfway through that a job is also a commissioning.
 */
export async function formsForJob(siteId: number, jobId: number): Promise<JobFormEntry[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT f.id AS form_id, f.name, f.is_public,
            MAX(hf.is_required) AS is_required,
            (SELECT v.id FROM job_form_versions v
              WHERE v.form_id = f.id AND v.is_draft = 0
              ORDER BY v.version DESC LIMIT 1) AS version_id,
            (SELECT v.version FROM job_form_versions v
              WHERE v.form_id = f.id AND v.is_draft = 0
              ORDER BY v.version DESC LIMIT 1) AS version,
            r.id AS response_id, r.submitted_at, r.respondent_name
       FROM job_card_headlines jh
       JOIN job_headline_forms hf ON hf.headline_id = jh.headline_id
       JOIN job_forms f           ON f.id = hf.form_id AND f.is_active = 1
       LEFT JOIN job_form_responses r ON r.job_card_id = jh.job_card_id AND r.form_id = f.id
      WHERE jh.job_card_id = ?
      GROUP BY f.id, f.name, f.is_public, version_id, version,
               r.id, r.submitted_at, r.respondent_name
      ORDER BY MIN(hf.sort_order), f.name`,
    [jobId],
  ).catch(() => [])

  return rows.map((r) => ({
    formId: Number(r.form_id),
    formName: String(r.name),
    /*
     * MAX over is_required: two headlines can both ask for the same form and
     * disagree about whether it is compulsory. Required wins, because a form
     * one headline insists on is insisted on.
     */
    isRequired: Number(r.is_required) === 1,
    isPublic: Number(r.is_public) === 1,
    versionId: r.version_id === null ? null : Number(r.version_id),
    version: r.version === null ? 0 : Number(r.version),
    responseId: r.response_id === null ? null : Number(r.response_id),
    submittedAt: (r.submitted_at as Date) ?? null,
    respondentName: String(r.respondent_name ?? ''),
  }))
}

export type LoadedResponse = {
  id: number
  jobId: number
  formId: number
  versionId: number
  version: number
  formName: string
  submittedAt: Date | null
  fields: FormField[]
  answers: FormAnswer[]
}

export async function loadResponse(
  siteId: number,
  responseId: number,
): Promise<LoadedResponse | null> {
  const head = await siteQueryOne<Row>(
    siteId,
    `SELECT r.id, r.job_card_id, r.form_id, r.version_id, r.submitted_at,
            v.version, f.name
       FROM job_form_responses r
       JOIN job_form_versions v ON v.id = r.version_id
       JOIN job_forms f         ON f.id = r.form_id
      WHERE r.id = ?`,
    [responseId],
  ).catch(() => null)
  if (!head) return null

  const [fieldRows, answerRows] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT * FROM job_form_fields WHERE version_id = ? ORDER BY sort_order, id`,
      [Number(head.version_id)],
    ),
    siteQuery<Row>(siteId, `SELECT * FROM job_form_answers WHERE response_id = ?`, [responseId]),
  ])

  return {
    id: Number(head.id),
    jobId: Number(head.job_card_id),
    formId: Number(head.form_id),
    versionId: Number(head.version_id),
    version: Number(head.version),
    formName: String(head.name),
    submittedAt: (head.submitted_at as Date) ?? null,
    fields: fieldRows.map(mapField),
    answers: answerRows.map((a) => ({
      fieldId: Number(a.field_id),
      text: a.value_text === null ? null : String(a.value_text),
      number: a.value_number === null ? null : toNum(a.value_number),
      date: a.value_date === null ? null : String(a.value_date),
      bool: a.value_bool === null ? null : Number(a.value_bool) === 1,
      attachmentId: a.attachment_id === null ? null : Number(a.attachment_id),
      recordId: a.record_id === null ? null : Number(a.record_id),
      latitude: a.latitude === null ? null : toNum(a.latitude),
      longitude: a.longitude === null ? null : toNum(a.longitude),
    })),
  }
}

/**
 * Save what has been filled in so far, and optionally submit it.
 *
 * ── DRAFT AND SUBMIT ARE ONE FUNCTION ──────────────────────────────────────
 *
 * Two would mean two places writing answers, and the second one somebody adds a
 * field type to is the one that gets forgotten. `submit` is a flag, and the
 * only thing it changes is whether the response is validated and stamped.
 *
 * A DRAFT IS NOT VALIDATED, deliberately. Somebody halfway up a ladder saving
 * what they have so far must not be told the reading they have not taken yet is
 * required — that is a save button that refuses to save, which teaches people
 * not to press it.
 */
export async function saveResponse(
  siteId: number,
  actor: Actor,
  input: {
    jobId: number
    formId: number
    responseId?: number | null
    assetId?: number | null
    answers: readonly FormAnswer[]
    submit: boolean
  },
): Promise<FormResult> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, document_number FROM job_cards WHERE id = ?`,
    [input.jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so its forms cannot be changed.' }
  }

  const form = await getForm(siteId, input.formId)
  if (!form) return { ok: false, error: 'That form no longer exists.' }
  if (form.liveVersionId === null) {
    return { ok: false, error: `${form.name} has not been published yet.` }
  }

  const existing = input.responseId
    ? await siteQueryOne<Row>(
        siteId,
        `SELECT id, version_id, submitted_at FROM job_form_responses WHERE id = ?`,
        [input.responseId],
      )
    : await siteQueryOne<Row>(
        siteId,
        `SELECT id, version_id, submitted_at FROM job_form_responses
          WHERE job_card_id = ? AND form_id = ? LIMIT 1`,
        [input.jobId, input.formId],
      )

  /*
   * A response keeps the version it was STARTED against, even when a newer one
   * has since been published. §24: template edits must not alter historical
   * submissions, and silently re-pointing a half-finished response at v4 would
   * change the questions under somebody mid-answer.
   */
  const versionId = existing ? Number(existing.version_id) : form.liveVersionId

  const fields = (
    await siteQuery<Row>(
      siteId,
      `SELECT * FROM job_form_fields WHERE version_id = ? ORDER BY sort_order, id`,
      [versionId],
    )
  ).map(mapField)

  const byField = new Map(input.answers.map((a) => [a.fieldId, a]))

  if (input.submit) {
    const problems = validateResponse(fields, byField)
    if (problems.length > 0) {
      return {
        ok: false,
        error:
          problems.length === 1
            ? problems[0]!
            : `${problems[0]} And ${problems.length - 1} other ${problems.length === 2 ? 'field' : 'fields'}.`,
      }
    }
  }

  const answerable = new Set(fields.filter((f) => takesAnswer(f.fieldType)).map((f) => f.id))

  const responseId = await siteTransaction(siteId, async (tx) => {
    let id: number
    if (existing) {
      id = Number(existing.id)
      await tx.execute(
        `UPDATE job_form_responses
            SET asset_id = ?,
                submitted_at = ${input.submit ? 'NOW()' : 'submitted_at'},
                respondent_user_id = ?, respondent_name = ?
          WHERE id = ?`,
        [input.assetId ?? null, actor.userId, actor.userName.slice(0, 120), id] as never,
      )
    } else {
      const [res] = await tx.execute(
        `INSERT INTO job_form_responses
           (job_card_id, form_id, version_id, asset_id, submitted_at,
            respondent_user_id, respondent_name)
         VALUES (?,?,?,?,${input.submit ? 'NOW()' : 'NULL'},?,?)`,
        [
          input.jobId,
          input.formId,
          versionId,
          input.assetId ?? null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      id = Number((res as { insertId: number }).insertId)
    }

    /*
     * Answers replaced wholesale, like the fields on a draft. An answer that
     * was cleared has to disappear, and a diff would need the client to say
     * which ones it removed — state a page refresh loses.
     */
    await tx.execute(`DELETE FROM job_form_answers WHERE response_id = ?`, [id] as never)
    for (const answer of input.answers) {
      // A field that is not on this version, or takes no answer, is ignored
      // rather than refused: a stale screen must not fail a save.
      if (!answerable.has(answer.fieldId)) continue
      await tx.execute(
        `INSERT INTO job_form_answers
           (response_id, field_id, value_text, value_number, value_date, value_bool,
            attachment_id, record_id, latitude, longitude)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          answer.fieldId,
          answer.text ?? null,
          answer.number ?? null,
          answer.date ?? null,
          answer.bool === null || answer.bool === undefined ? null : answer.bool ? 1 : 0,
          answer.attachmentId ?? null,
          answer.recordId ?? null,
          answer.latitude ?? null,
          answer.longitude ?? null,
        ] as never,
      )
    }
    return id
  })

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: input.jobId,
    action: input.submit ? 'form_submitted' : 'form_saved',
    detail: `${form.name} v${form.liveVersion}${input.submit ? '' : ' (draft)'}`,
  })

  return { ok: true, id: responseId }
}

/* ── The close gate ───────────────────────────────────────────────────────── */

/**
 * Required forms this job has not submitted, for the close gate.
 *
 * Inside the caller's transaction, matching outstandingRequiredTx in
 * jobHeadlines — the check and the close must see the same state, or a form
 * submitted in the moment between them lets a job close it should have blocked.
 *
 * A form with nothing published is NOT outstanding. It cannot be filled in, so
 * blocking on it would strand every job carrying that headline until somebody
 * publishes — a job that cannot close for a reason nobody on the job can fix.
 */
export async function outstandingFormsTx(
  tx: PoolConnection,
  jobId: number,
): Promise<string[]> {
  try {
    const [rows] = await tx.query<Row[]>(
      `SELECT DISTINCT f.name
         FROM job_card_headlines jh
         JOIN job_headline_forms hf ON hf.headline_id = jh.headline_id AND hf.is_required = 1
         JOIN job_forms f           ON f.id = hf.form_id AND f.is_active = 1
        WHERE jh.job_card_id = ?
          AND EXISTS (SELECT 1 FROM job_form_versions v
                       WHERE v.form_id = f.id AND v.is_draft = 0)
          AND NOT EXISTS (
            SELECT 1 FROM job_form_responses r
             WHERE r.job_card_id = jh.job_card_id
               AND r.form_id = f.id
               AND r.submitted_at IS NOT NULL
          )`,
      [jobId] as never,
    )
    return rows.map((r) => String(r.name))
  } catch {
    // A site without 222 has no forms to be outstanding.
    return []
  }
}

/** One answered field, flattened for the printed job sheet. */
export type AnsweredField = {
  formName: string
  label: string
  hint: string | null
  answer: string
  respondentName: string
  attachmentId: number | null
}

/**
 * Every SUBMITTED answer on a job, for the job sheet (§35).
 *
 * ── WHY SUBMITTED ONLY ─────────────────────────────────────────────────────
 *
 * The same rule the portal applies, for a stronger reason: this document is
 * handed to a customer or filed as the record of what was done. A draft is a
 * technician's working notes — readings still being taken — and printing one as
 * though it were the finding is how a document says something nobody stood
 * behind.
 *
 * The checklist this replaces filtered on `completedAt !== null` for exactly the
 * same reason, and its comment said so: an unanswered check is not evidence of
 * anything.
 *
 * Structure fields are dropped and unanswered ones with them. A heading on a
 * printed sheet with nothing under it is a heading about nothing.
 */
export async function answeredFieldsFor(
  siteId: number,
  jobId: number,
): Promise<AnsweredField[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT f.name AS form_name, fl.label, fl.hint, fl.field_type, fl.unit,
              r.respondent_name,
              a.value_text, a.value_number, a.value_date, a.value_bool, a.attachment_id
         FROM job_form_responses r
         JOIN job_forms f        ON f.id = r.form_id
         JOIN job_form_fields fl ON fl.version_id = r.version_id
         JOIN job_form_answers a ON a.response_id = r.id AND a.field_id = fl.id
        WHERE r.job_card_id = ?
          AND r.submitted_at IS NOT NULL
          AND fl.field_type NOT IN ('heading','page_break')
        ORDER BY r.submitted_at, r.id, fl.sort_order, fl.id`,
      [jobId],
    )

    const out: AnsweredField[] = []
    for (const r of rows) {
      /*
       * Already formatted for a reader, because the pdf module renders what it
       * is given. "Yes" not 1, and a measurement carries its unit — a sheet
       * saying "Gas pressure: 250" is a number somebody has to remember the
       * meaning of.
       */
      let answer = ''
      if (r.value_bool !== null && r.value_bool !== undefined) {
        answer = Number(r.value_bool) === 1 ? 'Yes' : 'No'
      } else if (r.value_number !== null && r.value_number !== undefined) {
        answer = `${Number(r.value_number)}${r.unit ? ` ${String(r.unit)}` : ''}`
      } else if (r.value_date !== null && r.value_date !== undefined) {
        answer = String(r.value_date)
      } else if (r.value_text !== null && r.value_text !== undefined) {
        answer = String(r.value_text)
      }

      const hasFile = r.attachment_id !== null && r.attachment_id !== undefined
      if (answer.trim() === '' && !hasFile) continue

      out.push({
        formName: String(r.form_name),
        label: String(r.label),
        hint: r.hint === null ? null : String(r.hint),
        answer,
        respondentName: String(r.respondent_name ?? ''),
        attachmentId: hasFile ? Number(r.attachment_id) : null,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Whether the block-on-close rule is switched on.
 *
 * Moved here from jobHeadlines when 224 retired the checklist. The SETTING keeps
 * its name — `job_items_block_close` — because renaming it would silently reset
 * every site that had turned it off, and a schema key is not worth that. What it
 * governs is now required forms.
 */
export async function formsBlockClose(siteId: number): Promise<boolean> {
  const value = await getSetting(siteId, 'job_items_block_close').catch(() => '1')
  return value !== '0'
}

/* ── Drift ────────────────────────────────────────────────────────────────── */

export type FormDrift = {
  /** A form attached to a headline that has never been published. */
  unpublished: { formId: number; name: string; headlineCount: number }[]
  /**
   * A submitted response with a required field left empty.
   *
   * Should be impossible — submitForm validates — so a row here means either a
   * field became required after the response was submitted, or something wrote
   * answers without going through saveResponse.
   */
  incomplete: { responseId: number; jobId: number; formName: string; missing: number }[]
}

export async function reconcileJobForms(siteId: number): Promise<FormDrift> {
  const [unpublished, incomplete] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT f.id, f.name, COUNT(*) AS headline_count
         FROM job_headline_forms hf
         JOIN job_forms f ON f.id = hf.form_id AND f.is_active = 1
        WHERE NOT EXISTS (SELECT 1 FROM job_form_versions v
                           WHERE v.form_id = f.id AND v.is_draft = 0)
        GROUP BY f.id, f.name`,
    ).catch(() => []),
    siteQuery<Row>(
      siteId,
      `SELECT r.id, r.job_card_id, f.name, COUNT(*) AS missing
         FROM job_form_responses r
         JOIN job_forms f        ON f.id = r.form_id
         JOIN job_form_fields fl ON fl.version_id = r.version_id AND fl.is_required = 1
         LEFT JOIN job_form_answers a ON a.response_id = r.id AND a.field_id = fl.id
        WHERE r.submitted_at IS NOT NULL
          AND fl.field_type NOT IN ('heading','page_break')
          AND fl.show_if_field_id IS NULL
          AND a.id IS NULL
        GROUP BY r.id, r.job_card_id, f.name`,
    ).catch(() => []),
  ])

  return {
    unpublished: unpublished.map((r) => ({
      formId: Number(r.id),
      name: String(r.name),
      headlineCount: Number(r.headline_count),
    })),
    incomplete: incomplete.map((r) => ({
      responseId: Number(r.id),
      jobId: Number(r.job_card_id),
      formName: String(r.name),
      missing: Number(r.missing),
    })),
  }
}
