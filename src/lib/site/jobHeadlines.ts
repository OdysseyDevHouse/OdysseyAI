import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { getSetting } from './settings'
import {
  isFailedResponse,
  itemBlocker,
  mergeHeadlineItems,
  responseIsEvidence,
  validateHeadline,
  validateResponse,
  type ItemKind,
  type JobPriority,
  type ResponseType,
  type WorkPhase,
} from '../jobStatusModel'

/**
 * What KIND of job this is, and the work that comes with it.
 *
 * ── A HEADLINE IS NOT A CATEGORY ───────────────────────────────────────────
 *
 * `job_cards.title` says what this particular job is. A headline says what jobs of
 * its kind always require: the eight checks a service needs, the filter it always
 * consumes, the two hours it takes, the board it belongs on. A dropdown that only
 * labels the job is a report filter; a headline that attaches the work is the
 * difference between configuring a business once and every technician retyping the
 * same checklist.
 *
 * ── THE ITEMS ARE COPIED, NOT REFERENCED ───────────────────────────────────
 *
 * `job_card_items` holds its own name and response type. Editing "Check gas
 * pressure" to "Check refrigerant pressure" next March must not rewrite what
 * somebody signed off last week — the same argument the job lines make for
 * snapshotting product_code.
 *
 * The cost, stated plainly: correcting a typo in a template does not fix the jobs
 * already carrying it. That is the right trade. A completed check is a record of
 * what a person confirmed, and a record that changes underneath its author is not
 * a record.
 *
 * ── ONE ITEM TABLE FOR TASKS AND CHECKS ────────────────────────────────────
 *
 * The migration header argues this at length. In short: the only difference is
 * that a check captures a value, `kind` is a label for the screens, and two tables
 * would be two copies of the ordering and blocking rules.
 */

type Row = RowDataPacket & Record<string, unknown>

/** DATETIME columns arrive as driver Dates whose String() is a LOCALE string. */
const wallClock = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return (
      `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
      ` ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
    )
  }
  return String(value)
}

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/* ── Templates ─────────────────────────────────────────────────────────────── */

export type HeadlineItem = {
  id: number
  kind: ItemKind
  name: string
  hint: string | null
  responseType: ResponseType
  unit: string | null
  workPhase: WorkPhase
  isRequired: boolean
  /** Only meaningful for photo and signature items. See 119. */
  evidenceRequired: boolean
  sortOrder: number
}

export type HeadlinePart = {
  id: number
  productId: number
  productCode: string | null
  description: string | null
  qty: number
  lineKind: 'part' | 'labour' | 'travel' | 'charge'
}

export type JobHeadline = {
  id: number
  code: string
  name: string
  description: string | null
  defaultPriority: JobPriority | null
  defaultBoardId: number | null
  defaultBoardName: string | null
  suggestedMinutes: number | null
  requiredSkills: string | null
  sortOrder: number
  isActive: boolean
  /** How many jobs have used it. What makes deleting it a decision. */
  jobCount: number
  items: HeadlineItem[]
  parts: HeadlinePart[]
}

const mapItem = (r: Row): HeadlineItem => ({
  id: Number(r.id),
  kind: String(r.kind) as ItemKind,
  name: String(r.name),
  hint: text(r.hint),
  responseType: String(r.response_type) as ResponseType,
  unit: text(r.unit),
  workPhase: String(r.work_phase) as WorkPhase,
  isRequired: Number(r.is_required) === 1,
  evidenceRequired: Number(r.evidence_required) === 1,
  sortOrder: Number(r.sort_order),
})

/**
 * Every headline, with its items and parts.
 *
 * Three queries rather than one join: a headline with 12 items and 4 parts would
 * come back as 48 rows to be de-duplicated in JS, and the setup screen wants all
 * of them anyway. Cheap because a business has tens of headlines, not thousands.
 */
export async function listHeadlines(
  siteId: number,
  includeInactive = true,
): Promise<JobHeadline[]> {
  const heads = await siteQuery<Row>(
    siteId,
    `SELECT h.id, h.code, h.name, h.description, h.default_priority, h.default_board_id,
            h.suggested_minutes, h.required_skills, h.sort_order, h.is_active,
            b.name AS board_name,
            (SELECT COUNT(*) FROM job_card_headlines jch WHERE jch.headline_id = h.id) AS job_count
       FROM job_headlines h
       LEFT JOIN job_boards b ON b.id = h.default_board_id
      ${includeInactive ? '' : 'WHERE h.is_active = 1'}
      ORDER BY h.sort_order, h.name`,
  )
  if (heads.length === 0) return []

  const ids = heads.map((h) => Number(h.id))
  const placeholders = ids.map(() => '?').join(',')

  const [items, parts] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT id, headline_id, kind, name, hint, response_type, unit, work_phase,
              is_required, evidence_required, sort_order
         FROM job_headline_items
        WHERE headline_id IN (${placeholders})
        ORDER BY FIELD(work_phase,'before','during','after'), sort_order, id`,
      ids,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT hp.id, hp.headline_id, hp.product_id, hp.qty, hp.line_kind,
              p.code AS product_code, p.description
         FROM job_headline_parts hp
         LEFT JOIN products p ON p.id = hp.product_id
        WHERE hp.headline_id IN (${placeholders})
        ORDER BY hp.sort_order, hp.id`,
      ids,
    ),
  ])

  return heads.map((h) => {
    const id = Number(h.id)
    return {
      id,
      code: String(h.code),
      name: String(h.name),
      description: text(h.description),
      defaultPriority: h.default_priority === null ? null : (String(h.default_priority) as JobPriority),
      defaultBoardId: h.default_board_id === null ? null : Number(h.default_board_id),
      defaultBoardName: text(h.board_name),
      suggestedMinutes: h.suggested_minutes === null ? null : Number(h.suggested_minutes),
      requiredSkills: text(h.required_skills),
      sortOrder: Number(h.sort_order),
      isActive: Number(h.is_active) === 1,
      jobCount: Number(h.job_count ?? 0),
      items: items.filter((i) => Number(i.headline_id) === id).map(mapItem),
      parts: parts
        .filter((p) => Number(p.headline_id) === id)
        .map((p) => ({
          id: Number(p.id),
          productId: Number(p.product_id),
          productCode: text(p.product_code),
          description: text(p.description),
          qty: toNum(p.qty),
          lineKind: String(p.line_kind) as HeadlinePart['lineKind'],
        })),
    }
  })
}

export type HeadlineInput = {
  id: number | null
  code: string
  name: string
  description: string | null
  defaultPriority: JobPriority | null
  defaultBoardId: number | null
  suggestedMinutes: number | null
  requiredSkills: string | null
  sortOrder: number
  isActive: boolean
  items: {
    id: number | null
    kind: ItemKind
    name: string
    hint: string | null
    responseType: ResponseType
    unit: string | null
    workPhase: WorkPhase
    isRequired: boolean
    evidenceRequired: boolean
  }[]
  parts: { productId: number; qty: number; lineKind: HeadlinePart['lineKind'] }[]
}

export type HeadlineResult = { ok: true; id: number } | { ok: false; error: string }
export type ItemResult = { ok: true } | { ok: false; error: string }

/**
 * Create or update a headline and its items.
 *
 * ── THE ITEMS ARE MATCHED BY ID, NOT DELETED AND RE-INSERTED ───────────────
 *
 * This used to replace them wholesale, on the grounds that a template is a short
 * list somebody edits as a whole and diffing bought nothing. That was wrong, and
 * the cost was invisible: every re-insert allocated fresh ids, and
 * `job_card_items.headline_item_id` is ON DELETE SET NULL — so EVERY prior job's
 * link back to the template item it came from was silently nulled on every save.
 *
 * 114_job_headlines.sql keeps that column for one stated purpose: reporting on
 * which kind of work generates the most unfinished tasks. A single typo
 * correction destroyed it, and nothing anywhere said so.
 *
 * So: an item that arrives with an id is UPDATED, one without is inserted, and
 * only ids the user actually removed are deleted. The copies already on job
 * cards keep their own snapshot either way — that part was always right.
 */
export async function saveHeadline(
  siteId: number,
  actor: Actor,
  input: HeadlineInput,
): Promise<HeadlineResult> {
  const refusal = validateHeadline({
    code: input.code,
    name: input.name,
    suggestedMinutes: input.suggestedMinutes,
    items: input.items,
  })
  if (refusal) return { ok: false, error: refusal }

  const code = input.code.trim().toUpperCase()

  return siteTransaction(siteId, async (tx) => {
    const [clashRows] = await tx.query<Row[]>(
      `SELECT id FROM job_headlines WHERE code = ? AND id <> ? LIMIT 1`,
      [code, input.id ?? 0],
    )
    if (clashRows.length > 0) {
      return { ok: false as const, error: `Another headline already uses the code ${code}.` }
    }

    let id = input.id ?? 0
    if (id === 0) {
      const [result] = await tx.execute(
        `INSERT INTO job_headlines
           (code, name, description, default_priority, default_board_id,
            suggested_minutes, required_skills, sort_order, is_active)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          code,
          input.name.trim(),
          text(input.description),
          input.defaultPriority,
          input.defaultBoardId,
          input.suggestedMinutes,
          text(input.requiredSkills),
          input.sortOrder,
          input.isActive ? 1 : 0,
        ],
      )
      id = Number((result as { insertId: number }).insertId)
    } else {
      /*
       * `code` is deliberately NOT updated. It is frozen at creation so renaming
       * a headline relabels every job that used it rather than stranding them —
       * the same rule job_statuses.code follows.
       */
      await tx.execute(
        `UPDATE job_headlines
            SET name = ?, description = ?, default_priority = ?, default_board_id = ?,
                suggested_minutes = ?, required_skills = ?, sort_order = ?, is_active = ?
          WHERE id = ?`,
        [
          input.name.trim(),
          text(input.description),
          input.defaultPriority,
          input.defaultBoardId,
          input.suggestedMinutes,
          text(input.requiredSkills),
          input.sortOrder,
          input.isActive ? 1 : 0,
          id,
        ],
      )
      /*
       * The items somebody actually REMOVED, and only those.
       *
       * Everything the form still carries an id for survives with that id, so
       * the jobs pointing at it keep pointing at it. Parts have no such
       * back-reference — nothing copies a part id onto a job — so they stay a
       * wholesale replace.
       */
      const keptIds = input.items
        .map((i) => i.id)
        .filter((v): v is number => typeof v === 'number' && v > 0)

      if (keptIds.length > 0) {
        await tx.execute(
          `DELETE FROM job_headline_items
            WHERE headline_id = ? AND id NOT IN (${keptIds.map(() => '?').join(',')})`,
          [id, ...keptIds],
        )
      } else {
        await tx.execute(`DELETE FROM job_headline_items WHERE headline_id = ?`, [id])
      }
      await tx.execute(`DELETE FROM job_headline_parts WHERE headline_id = ?`, [id])
    }

    for (const [index, item] of input.items.entries()) {
      // Forced to 0 for anything that cannot hold a file. validateHeadline
      // already refuses the combination, so this is belt-and-braces against a
      // caller that skipped validation — the flag must never be 1 on an item
      // with no way to satisfy it, or the job becomes uncloseable.
      const evidence = responseIsEvidence(item.responseType) && item.evidenceRequired ? 1 : 0

      if (typeof item.id === 'number' && item.id > 0) {
        /*
         * UPDATE, and the `headline_id = ?` in the WHERE is not decoration: the
         * id arrives from a form, and without it somebody could edit an item
         * belonging to a different headline by changing a number.
         */
        await tx.execute(
          `UPDATE job_headline_items
              SET kind = ?, name = ?, hint = ?, response_type = ?, unit = ?,
                  work_phase = ?, is_required = ?, evidence_required = ?, sort_order = ?
            WHERE id = ? AND headline_id = ?`,
          [
            item.kind,
            item.name.trim(),
            text(item.hint),
            item.responseType,
            text(item.unit),
            item.workPhase,
            item.isRequired ? 1 : 0,
            evidence,
            index,
            item.id,
            id,
          ],
        )
        continue
      }

      await tx.execute(
        `INSERT INTO job_headline_items
           (headline_id, kind, name, hint, response_type, unit, work_phase, is_required,
            evidence_required, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          item.kind,
          item.name.trim(),
          text(item.hint),
          item.responseType,
          text(item.unit),
          item.workPhase,
          item.isRequired ? 1 : 0,
          evidence,
          index,
        ],
      )
    }

    for (const [index, part] of input.parts.entries()) {
      if (!Number.isFinite(part.productId) || part.productId <= 0) continue
      // INSERT IGNORE: the unique key is (headline_id, product_id, line_kind) and
      // a form can offer the same product twice. Skipping beats refusing the save.
      await tx.execute(
        `INSERT IGNORE INTO job_headline_parts (headline_id, product_id, qty, line_kind, sort_order)
         VALUES (?,?,?,?,?)`,
        [id, part.productId, part.qty, part.lineKind, index],
      )
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: 0,
      action: input.id === null ? 'headline_created' : 'headline_updated',
      detail: `${code} — ${input.name.trim()} (${input.items.length} items)`,
    })

    return { ok: true as const, id }
  })
}

/**
 * Delete a headline.
 *
 * Refused once a job has used it: `fk_jch_headline` is RESTRICT, because a
 * headline names what a job WAS and deleting it would erase the answer to what
 * kind of work was done. Retiring with `is_active = 0` is the offered alternative,
 * exactly as stock locations do.
 */
export async function deleteHeadline(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<ItemResult> {
  const head = await siteQueryOne<Row>(
    siteId,
    `SELECT h.id, h.code, h.name,
            (SELECT COUNT(*) FROM job_card_headlines jch WHERE jch.headline_id = h.id) AS job_count
       FROM job_headlines h WHERE h.id = ?`,
    [id],
  )
  if (!head) return { ok: false, error: 'That headline no longer exists.' }

  const used = Number(head.job_count ?? 0)
  if (used > 0) {
    return {
      ok: false,
      error: `${used} ${used === 1 ? 'job has' : 'jobs have'} been logged under ${head.name}, so it cannot be deleted — that history would lose what kind of work it was. Switch it off instead.`,
    }
  }

  await siteExecute(siteId, `DELETE FROM job_headlines WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: 0,
    action: 'headline_deleted',
    detail: `${head.code} — ${head.name}`,
  })
  return { ok: true }
}

/* ── Headlines on a job ────────────────────────────────────────────────────── */

export type JobItem = {
  id: number
  headlineId: number | null
  headlineName: string | null
  kind: ItemKind
  name: string
  hint: string | null
  responseType: ResponseType
  unit: string | null
  workPhase: WorkPhase
  isRequired: boolean
  sortOrder: number
  response: string | null
  completedAt: string | null
  completedByName: string | null
  isFailed: boolean
  note: string | null
  /** Set when a photo or signature has actually been captured. See 119. */
  evidenceRequired: boolean
  attachmentId: number | null
  /**
   * Joined so a list of 30 items renders its thumbnails without 30 more queries.
   * Null whenever attachmentId is — the FK is SET NULL, so a deleted file
   * un-answers its item rather than leaving a name pointing at nothing.
   */
  attachmentName: string | null
  attachmentMime: string | null
}

export async function jobItems(siteId: number, jobId: number): Promise<JobItem[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT i.id, i.headline_id, i.kind, i.name, i.hint, i.response_type, i.unit,
            i.work_phase, i.is_required, i.sort_order, i.response, i.completed_at,
            i.completed_by_name, i.is_failed, i.note, h.name AS headline_name,
            i.evidence_required, i.attachment_id,
            d.filename AS attachment_filename, d.mime_type AS attachment_mime
       FROM job_card_items i
       LEFT JOIN job_headlines h ON h.id = i.headline_id
       LEFT JOIN party_documents d ON d.id = i.attachment_id
      WHERE i.job_card_id = ?
      ORDER BY FIELD(i.work_phase,'before','during','after'), i.sort_order, i.id`,
    [jobId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    headlineId: r.headline_id === null ? null : Number(r.headline_id),
    headlineName: text(r.headline_name),
    kind: String(r.kind) as ItemKind,
    name: String(r.name),
    hint: text(r.hint),
    responseType: String(r.response_type) as ResponseType,
    unit: text(r.unit),
    workPhase: String(r.work_phase) as WorkPhase,
    isRequired: Number(r.is_required) === 1,
    sortOrder: Number(r.sort_order),
    response: text(r.response),
    completedAt: wallClock(r.completed_at),
    completedByName: text(r.completed_by_name),
    isFailed: Number(r.is_failed) === 1,
    note: text(r.note),
    evidenceRequired: Number(r.evidence_required) === 1,
    attachmentId: r.attachment_id === null ? null : Number(r.attachment_id),
    attachmentName: text(r.attachment_filename),
    attachmentMime: text(r.attachment_mime),
  }))
}

export async function jobHeadlineIds(siteId: number, jobId: number): Promise<number[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT headline_id FROM job_card_headlines WHERE job_card_id = ? ORDER BY sort_order`,
    [jobId],
  )
  return rows.map((r) => Number(r.headline_id))
}

export type ApplyResult =
  | { ok: true; added: number; merged: { name: string; from: string[] }[] }
  | { ok: false; error: string }

/**
 * Set which headlines a job carries, and copy their items onto it.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 * It never removes an item somebody has already completed, even when the headline
 * that produced it is deselected. A signed-off check is a record of what happened;
 * deleting it because a category changed would destroy evidence. Untouched items
 * from a removed headline ARE cleared, because those are just clutter.
 *
 * ── MERGING ────────────────────────────────────────────────────────────────
 *
 * Two headlines that both require "Check gas pressure" produce ONE item, and the
 * caller is told which were merged so the screen can say so rather than leaving
 * somebody to wonder. `mergeHeadlineItems` is pure and tested; this function only
 * feeds it and writes the result.
 */
export async function applyHeadlines(
  siteId: number,
  actor: Actor,
  jobId: number,
  headlineIds: readonly number[],
): Promise<ApplyResult> {
  const wanted = [...new Set(headlineIds)].filter((id) => Number.isFinite(id) && id > 0)

  return siteTransaction(siteId, async (tx) => {
    const [jobRows] = await tx.query<Row[]>(
      `SELECT id, status, priority FROM job_cards WHERE id = ?`,
      [jobId],
    )
    const job = jobRows[0]
    if (!job) return { ok: false as const, error: 'That job no longer exists.' }
    if (String(job.status) !== 'open') {
      return { ok: false as const, error: 'This job is closed, so its headlines cannot be changed.' }
    }

    // The templates, with their items, in the order the caller chose them.
    const heads: { id: number; name: string; items: Row[] }[] = []
    for (const id of wanted) {
      const [hRows] = await tx.query<Row[]>(
        `SELECT id, name, is_active FROM job_headlines WHERE id = ?`,
        [id],
      )
      const head = hRows[0]
      if (!head) return { ok: false as const, error: 'One of those headlines no longer exists.' }
      const [itemRows] = await tx.query<Row[]>(
        `SELECT id, kind, name, hint, response_type, unit, work_phase, is_required,
                evidence_required, sort_order
           FROM job_headline_items WHERE headline_id = ?
          ORDER BY FIELD(work_phase,'before','during','after'), sort_order, id`,
        [id],
      )
      heads.push({ id: Number(head.id), name: String(head.name), items: itemRows })
    }

    // Replace the links.
    await tx.execute(`DELETE FROM job_card_headlines WHERE job_card_id = ?`, [jobId])
    for (const [index, head] of heads.entries()) {
      await tx.execute(
        `INSERT INTO job_card_headlines (job_card_id, headline_id, sort_order) VALUES (?,?,?)`,
        [jobId, head.id, index],
      )
    }

    /*
     * Clear only UNTOUCHED template items. An item somebody completed stays, and
     * so does anything added by hand (headline_item_id IS NULL) — a technician who
     * wrote their own task does not lose it because the office reclassified the job.
     *
     * `attachment_id IS NULL` joined that list in 119. A photo item carries its
     * answer as a FILE and often no text at all, so without this clause a
     * reclassification would delete the item and orphan the photograph — the one
     * piece of evidence on the job that cannot be re-taken after the technician
     * has driven away.
     */
    await tx.execute(
      `DELETE FROM job_card_items
        WHERE job_card_id = ? AND headline_item_id IS NOT NULL
          AND completed_at IS NULL AND response IS NULL AND attachment_id IS NULL`,
      [jobId],
    )

    // What survived, so a re-apply does not duplicate it.
    const [survivingRows] = await tx.query<Row[]>(
      `SELECT name FROM job_card_items WHERE job_card_id = ?`,
      [jobId],
    )
    const surviving = new Set(survivingRows.map((r) => String(r.name).trim().toLowerCase()))

    const { items, merged } = mergeHeadlineItems(
      heads.map((h) => ({
        headlineName: h.name,
        items: h.items.map((i) => ({
          headlineId: h.id,
          templateId: Number(i.id),
          kind: String(i.kind) as ItemKind,
          name: String(i.name),
          hint: text(i.hint),
          responseType: String(i.response_type) as ResponseType,
          unit: text(i.unit),
          workPhase: String(i.work_phase) as WorkPhase,
          isRequired: Number(i.is_required) === 1,
          evidenceRequired: Number(i.evidence_required) === 1,
        })),
      })),
    )

    let added = 0
    for (const [index, item] of items.entries()) {
      if (surviving.has(item.name.trim().toLowerCase())) continue
      await tx.execute(
        `INSERT INTO job_card_items
           (job_card_id, headline_item_id, headline_id, kind, name, hint, response_type,
            unit, work_phase, is_required, evidence_required, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          jobId,
          item.templateId,
          item.headlineId,
          item.kind,
          item.name.trim(),
          item.hint,
          item.responseType,
          item.unit,
          item.workPhase,
          item.isRequired ? 1 : 0,
          // Snapshotted from the template, like every other column here: editing
          // the template next year must not change what this job already asked for.
          item.evidenceRequired ? 1 : 0,
          index,
        ],
      )
      added++
    }

    /*
     * The first headline that expresses a priority sets it, and only while the job
     * is still at its default. A headline must not overrule a dispatcher who
     * deliberately marked something urgent — the PRD says a manual choice should
     * not be silently overwritten by automation.
     */
    const withPriority = heads.find((h) => h.items.length >= 0)
    if (withPriority && String(job.priority) === 'normal') {
      const [pRows] = await tx.query<Row[]>(
        `SELECT default_priority FROM job_headlines WHERE id = ? AND default_priority IS NOT NULL`,
        [withPriority.id],
      )
      const preferred = pRows[0]?.default_priority
      if (preferred) {
        await tx.execute(`UPDATE job_cards SET priority = ? WHERE id = ?`, [preferred, jobId])
      }
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'headlines_set',
      detail:
        heads.length === 0
          ? 'Headlines cleared'
          : `${heads.map((h) => h.name).join(', ')} — ${added} item(s) added`,
    })

    return { ok: true as const, added, merged }
  })
}

/** Record an answer, or untick an item. Returns the refusal the screen shows. */
export async function recordItem(
  siteId: number,
  actor: Actor,
  itemId: number,
  input: { response: string | null; note: string | null; complete: boolean },
): Promise<ItemResult> {
  const item = await siteQueryOne<Row>(
    siteId,
    `SELECT i.id, i.job_card_id, i.name, i.response_type, i.evidence_required,
            i.attachment_id, j.status
       FROM job_card_items i JOIN job_cards j ON j.id = i.job_card_id
      WHERE i.id = ?`,
    [itemId],
  )
  if (!item) return { ok: false, error: 'That item no longer exists.' }
  if (String(item.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so its checks cannot be changed.' }
  }

  const responseType = String(item.response_type) as ResponseType
  const response = text(input.response)
  const refusal = validateResponse(responseType, response)
  if (refusal) return { ok: false, error: refusal }

  /*
   * A check that captures a value cannot be complete without one. Otherwise
   * "completed" would mean somebody pressed a button, which is exactly the
   * box-ticking the checklist exists to prevent.
   *
   * itemBlocker() rather than a test on `response` here, because since 119 the
   * value for a photo or signature is the FILE. Asking for text as well would
   * make a signed item impossible to tick, and a hand-rolled second rule beside
   * the close guard is how the two come to disagree about what "done" means.
   */
  if (input.complete) {
    const blocker = itemBlocker({
      responseType,
      evidenceRequired: Number(item.evidence_required) === 1,
      attachmentId: item.attachment_id === null ? null : Number(item.attachment_id),
      response,
    })
    if (blocker) return { ok: false, error: `${item.name}: ${blocker}` }
  }

  const failed = isFailedResponse(responseType, response)

  await siteExecute(
    siteId,
    `UPDATE job_card_items
        SET response = ?, note = ?, is_failed = ?,
            completed_at = ${input.complete ? 'NOW()' : 'NULL'},
            completed_by_user_id = ${input.complete ? '?' : 'NULL'},
            completed_by_name = ${input.complete ? '?' : 'NULL'}
      WHERE id = ?`,
    input.complete
      ? [response, text(input.note), failed ? 1 : 0, actor.userId, actor.userName, itemId]
      : [response, text(input.note), failed ? 1 : 0, itemId],
  )

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: Number(item.job_card_id),
    action: input.complete ? 'item_completed' : 'item_reopened',
    detail: `${item.name}${response ? `: ${response}` : ''}${failed ? ' (FAILED)' : ''}`,
  })
  return { ok: true }
}

/**
 * Attach a captured photo or signature to a check, and tick it off.
 *
 * ── WHY THE UPLOAD IS THE CALLER'S JOB ──────────────────────────────────────
 *
 * `storeUpload()` has already written the bytes by the time this runs, and its
 * header states the contract: if the metadata insert fails, the caller unlinks
 * the file or it is orphaned. So this function takes a StoredFile rather than a
 * File, and RETURNS the refusal instead of throwing, so the action layer can
 * clean up the disk on every path out of here.
 *
 * ── WHY THE TWO WRITES ARE ONE TRANSACTION ──────────────────────────────────
 *
 * A party_documents row with no item pointing at it is a stray file on the Files
 * tab. An item pointing at a row that was rolled back is worse — the FK would
 * refuse it, so the real risk is the reverse order. Both in one transaction
 * means the only two outcomes are "captured" and "nothing happened".
 */
export async function captureEvidence(
  siteId: number,
  actor: Actor,
  itemId: number,
  file: { storedName: string; filename: string; mimeType: string | null; sizeBytes: number },
  caption: string | null,
): Promise<ItemResult & { attachmentId?: number }> {
  const item = await siteQueryOne<Row>(
    siteId,
    `SELECT i.id, i.job_card_id, i.name, i.response_type, i.attachment_id, j.status
       FROM job_card_items i JOIN job_cards j ON j.id = i.job_card_id
      WHERE i.id = ?`,
    [itemId],
  )
  if (!item) return { ok: false, error: 'That item no longer exists.' }
  if (String(item.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so its checks cannot be changed.' }
  }

  const responseType = String(item.response_type) as ResponseType
  if (!responseIsEvidence(responseType)) {
    return { ok: false, error: `${item.name} does not take a photo or a signature.` }
  }

  const jobId = Number(item.job_card_id)

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute<import('mysql2/promise').ResultSetHeader>(
      `INSERT INTO party_documents
         (entity, entity_id, filename, stored_name, mime_type, size_bytes,
          description, uploaded_by, uploaded_name)
       VALUES ('job_card',?,?,?,?,?,?,?,?)`,
      [
        jobId,
        file.filename.slice(0, 255),
        file.storedName.slice(0, 190),
        file.mimeType?.slice(0, 120) ?? null,
        Math.max(0, Math.trunc(file.sizeBytes)),
        // The description says which question this answers, so the Files tab is
        // readable on its own. Evidence IS a document on the job; the item link
        // says what it is for, not where it lives.
        `${String(item.name)}${caption?.trim() ? ` — ${caption.trim()}` : ''}`.slice(0, 400),
        actor.userId,
        actor.userName.slice(0, 120),
      ],
    )
    const attachmentId = Number(res.insertId)

    /*
     * The caption goes in `response` and the file in `attachment_id`. Recapturing
     * REPLACES the link: the previous party_documents row stays on the Files tab
     * rather than being deleted, because a technician who took a better photo has
     * not made the first one untrue, and silently destroying evidence on a second
     * upload is the wrong default for the one table where evidence lives.
     */
    await tx.execute(
      `UPDATE job_card_items
          SET attachment_id = ?, response = ?, is_failed = 0,
              completed_at = NOW(), completed_by_user_id = ?, completed_by_name = ?
        WHERE id = ?`,
      [attachmentId, text(caption), actor.userId, actor.userName, itemId],
    )

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: responseType === 'signature' ? 'signature_captured' : 'photo_captured',
      detail: `${String(item.name)} — ${file.filename}`,
    })

    return { ok: true as const, attachmentId }
  })
}

/** Add a one-off task or check nobody templated. */
export async function addJobItem(
  siteId: number,
  actor: Actor,
  jobId: number,
  input: {
    kind: ItemKind
    name: string
    responseType: ResponseType
    unit: string | null
    workPhase: WorkPhase
    isRequired: boolean
  },
): Promise<ItemResult> {
  if (!input.name.trim()) return { ok: false, error: 'Give it a name.' }
  if (input.name.trim().length > 190) return { ok: false, error: 'That name is too long.' }

  const job = await siteQueryOne<Row>(siteId, `SELECT id, status FROM job_cards WHERE id = ?`, [jobId])
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'This job is closed.' }
  }

  const next = await siteQueryOne<Row>(
    siteId,
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM job_card_items WHERE job_card_id = ?`,
    [jobId],
  )

  // headline_item_id stays NULL, which is what protects it from being cleared
  // when the job's headlines change. See applyHeadlines.
  await siteExecute(
    siteId,
    `INSERT INTO job_card_items
       (job_card_id, kind, name, response_type, unit, work_phase, is_required,
        evidence_required, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      jobId,
      input.kind,
      input.name.trim(),
      input.responseType,
      text(input.unit),
      input.workPhase,
      input.isRequired ? 1 : 0,
      // A one-off photo or signature holds itself to the same rule as a templated
      // one. There is no reason a check somebody added on site should be satisfiable
      // by typing when the identical templated check is not.
      responseIsEvidence(input.responseType) ? 1 : 0,
      Number(next?.n ?? 1),
    ],
  )
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'item_added',
    detail: input.name.trim(),
  })
  return { ok: true }
}

export async function deleteJobItem(
  siteId: number,
  actor: Actor,
  itemId: number,
): Promise<ItemResult> {
  const item = await siteQueryOne<Row>(
    siteId,
    `SELECT i.id, i.job_card_id, i.name, i.completed_at, j.status
       FROM job_card_items i JOIN job_cards j ON j.id = i.job_card_id
      WHERE i.id = ?`,
    [itemId],
  )
  if (!item) return { ok: false, error: 'That item no longer exists.' }
  if (String(item.status) !== 'open') return { ok: false, error: 'This job is closed.' }
  if (item.completed_at !== null) {
    return {
      ok: false,
      error: `${item.name} has already been signed off, so it cannot be removed. Untick it first if it was recorded in error.`,
    }
  }

  await siteExecute(siteId, `DELETE FROM job_card_items WHERE id = ?`, [itemId])
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: Number(item.job_card_id),
    action: 'item_removed',
    detail: String(item.name),
  })
  return { ok: true }
}

/**
 * Required items still unanswered on a job.
 *
 * Used by the close guard inside setStatus. Its own tolerant function rather than
 * inline SQL there, so a site without migration 114 can still close a job.
 */
export async function outstandingRequiredTx(
  tx: PoolConnection,
  jobId: number,
): Promise<string[]> {
  try {
    const [rows] = await tx.query<Row[]>(
      // The second clause is not redundant with the first. recordItem cannot set
      // completed_at on an evidence item without a file, but DELETING the
      // attachment afterwards nulls attachment_id via the FK and leaves
      // completed_at standing. Without this the job would close on the strength of
      // a photograph nobody has. An item in that state reads as outstanding, which
      // is recoverable; closing over it is not.
      `SELECT name FROM job_card_items
        WHERE job_card_id = ? AND is_required = 1
          AND (completed_at IS NULL OR (evidence_required = 1 AND attachment_id IS NULL))
        ORDER BY FIELD(work_phase,'before','during','after'), sort_order LIMIT 20`,
      [jobId],
    )
    return rows.map((r) => String(r.name))
  } catch {
    // The table does not exist on this site yet. A missing feature must not stop
    // somebody closing a job — the same stance reservedQtyFor takes on online holds.
    return []
  }
}

/** Whether the block-on-close rule is switched on. */
export async function itemsBlockClose(siteId: number): Promise<boolean> {
  const value = await getSetting(siteId, 'job_items_block_close').catch(() => '1')
  return value !== '0'
}

/** Whether a job must carry at least one headline. */
export async function headlineRequired(siteId: number): Promise<boolean> {
  const value = await getSetting(siteId, 'job_headline_required').catch(() => '0')
  return value === '1'
}

export type HeadlineDrift = {
  /**
   * Items completed with no answer, on a type that needs one.
   *
   * recordItem refuses this, so a row here means the database was edited directly
   * — or an older build wrote it before the guard existed.
   */
  completedWithoutAnswer: { itemId: number; jobId: number; name: string; responseType: string }[]
  /**
   * A photo or signature item marked complete with no file behind it.
   *
   * The serious one. Every other shape here is a figure disagreeing with itself;
   * this is a job that LOOKS signed off and has nothing to show. It happens if the
   * attachment row is deleted — the FK sets attachment_id to NULL and leaves
   * completed_at standing, which is the right trade (better an item that reports
   * itself than a pointer to bytes that are gone) but must be visible.
   */
  completedWithoutEvidence: { itemId: number; jobId: number; name: string; responseType: string }[]
  /**
   * A stored is_failed that disagrees with the response beside it. is_failed is
   * derived on write and stored for the indexed exception query; if the two ever
   * diverge, the exception report is lying.
   */
  failedFlagWrong: { itemId: number; jobId: number; name: string; response: string | null; isFailed: boolean }[]
  /** Open jobs carrying no headline while the setting demands one. */
  missingHeadline: { jobId: number; documentNumber: string | null }[]
}

/** Drift between what was recorded and what the rules allow. Reports, never repairs. */
export async function reconcileJobHeadlines(siteId: number): Promise<HeadlineDrift> {
  const [noAnswer, noEvidence, flags, missing, required] = await Promise.all([
    siteQuery<Row>(
      siteId,
      // Photo and signature excluded: since 119 their answer is the FILE, and a
      // signature with no typed caption is complete. Leaving them in would report
      // every correctly captured signature as drift, and a reconciliation screen
      // that cries wolf is one nobody reads.
      `SELECT id, job_card_id, name, response_type FROM job_card_items
        WHERE completed_at IS NOT NULL
          AND response_type NOT IN ('none','photo','signature')
          AND (response IS NULL OR TRIM(response) = '')`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT id, job_card_id, name, response_type FROM job_card_items
        WHERE completed_at IS NOT NULL AND evidence_required = 1
          AND attachment_id IS NULL`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT id, job_card_id, name, response, is_failed, response_type
         FROM job_card_items
        WHERE response_type IN ('yesno','passfail')`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT j.id, j.document_number FROM job_cards j
        WHERE j.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM job_card_headlines h WHERE h.job_card_id = j.id)`,
    ),
    headlineRequired(siteId),
  ])

  return {
    completedWithoutAnswer: noAnswer.map((r) => ({
      itemId: Number(r.id),
      jobId: Number(r.job_card_id),
      name: String(r.name),
      responseType: String(r.response_type),
    })),
    completedWithoutEvidence: noEvidence.map((r) => ({
      itemId: Number(r.id),
      jobId: Number(r.job_card_id),
      name: String(r.name),
      responseType: String(r.response_type),
    })),
    // Recomputed with the SAME pure function that wrote it, so the check cannot
    // drift from the rule by reimplementing it in SQL.
    failedFlagWrong: flags
      .filter((r) => {
        const expected = isFailedResponse(String(r.response_type) as ResponseType, text(r.response))
        return expected !== (Number(r.is_failed) === 1)
      })
      .map((r) => ({
        itemId: Number(r.id),
        jobId: Number(r.job_card_id),
        name: String(r.name),
        response: text(r.response),
        isFailed: Number(r.is_failed) === 1,
      })),
    // Only drift when the setting demands a headline. Otherwise a job without one
    // is a normal job, and reporting it would be noise.
    missingHeadline: required
      ? missing.map((r) => ({
          jobId: Number(r.id),
          documentNumber: text(r.document_number),
        }))
      : [],
  }
}
