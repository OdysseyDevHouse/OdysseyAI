import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { getSetting } from './settings'
import {
  validateHeadline,
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
 * ── THE CHECKLIST IS GONE ──────────────────────────────────────────────────
 *
 * A headline used to carry a list of tasks and checks of its own, copied onto
 * every job that took it. Migration 224 retired that: forms do the asking now,
 * and this file is back to what a headline has always actually been — a kind of
 * work, with the parts it consumes and the defaults it suggests.
 *
 * What survives here is the headline row, its parts, and the link from a job to
 * the headlines it carries. Anything about answering a question on a job lives
 * in jobForms.
 */

type Row = RowDataPacket & Record<string, unknown>

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/* ── Templates ─────────────────────────────────────────────────────────────── */

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
  parts: HeadlinePart[]
  /** Forms this headline attaches (222). Drives the picker on a job card. */
  formCount: number
}

/**
 * Every headline, with its parts.
 *
 * Two queries rather than one join: a headline with several parts would come back
 * as a row per part to be de-duplicated in JS, and the setup screen wants all of
 * them anyway. Cheap because a business has tens of headlines, not thousands.
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

  const [parts, formCounts] = await Promise.all([
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
    /*
     * How many ACTIVE forms each headline attaches (222).
     *
     * Counted rather than listed: the job card's picker needs to say "ticking
     * this asks for two forms", and the setup screen needs to say the same.
     * Neither needs the forms themselves, and a retired form must not be
     * counted — it is no longer asked for.
     *
     * Tolerant: a site that has not run 222 has no such table, and a headline
     * picker must not fail to render because forms do not exist there yet.
     */
    siteQuery<Row>(
      siteId,
      `SELECT hf.headline_id, COUNT(*) AS n
         FROM job_headline_forms hf
         JOIN job_forms f ON f.id = hf.form_id AND f.is_active = 1
        WHERE hf.headline_id IN (${placeholders})
        GROUP BY hf.headline_id`,
      ids,
    ).catch(() => [] as Row[]),
  ])

  const formsByHeadline = new Map(
    formCounts.map((r) => [Number(r.headline_id), Number(r.n)]),
  )

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
      formCount: formsByHeadline.get(id) ?? 0,
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
 * Create or update a headline and its parts.
 *
 * `input.items` is still accepted and still validated, because validateHeadline
 * enforces the code and duration rules in the same pass, but nothing is written
 * from it — 224 retired the checklist and forms carry the questions now.
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
      // Parts are a wholesale replace: nothing copies a part id onto a job, so
      // there is no back-reference to preserve across a save.
      await tx.execute(`DELETE FROM job_headline_parts WHERE headline_id = ?`, [id])
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
      detail: `${code} — ${input.name.trim()} (${input.parts.length} part(s))`,
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

export async function jobHeadlineIds(siteId: number, jobId: number): Promise<number[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT headline_id FROM job_card_headlines WHERE job_card_id = ? ORDER BY sort_order`,
    [jobId],
  )
  return rows.map((r) => Number(r.headline_id))
}

export type ApplyResult = { ok: true } | { ok: false; error: string }

/**
 * Set which headlines a job carries.
 *
 * This used to copy each headline's checklist onto the job as well, which is why
 * it once had something to report back. 224 retired that, so it now does the one
 * thing its name says: replace the links and record who changed them. Nothing is
 * merged or counted, because there is no longer anything to merge.
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

    // The templates, in the order the caller chose them.
    const heads: { id: number; name: string }[] = []
    for (const id of wanted) {
      const [hRows] = await tx.query<Row[]>(
        `SELECT id, name, is_active FROM job_headlines WHERE id = ?`,
        [id],
      )
      const head = hRows[0]
      if (!head) return { ok: false as const, error: 'One of those headlines no longer exists.' }
      heads.push({ id: Number(head.id), name: String(head.name) })
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
     * The first headline that expresses a priority sets it, and only while the job
     * is still at its default. A headline must not overrule a dispatcher who
     * deliberately marked something urgent — the PRD says a manual choice should
     * not be silently overwritten by automation.
     */
    const withPriority = heads[0]
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
          : `Headlines set to ${heads.map((h) => h.name).join(', ')}`,
    })

    return { ok: true as const }
  })
}

/** Whether a job must carry at least one headline. */
export async function headlineRequired(siteId: number): Promise<boolean> {
  const value = await getSetting(siteId, 'job_headline_required').catch(() => '0')
  return value === '1'
}

/**
 * Drift a headline can still be in.
 *
 * Most of what this used to report was about answers: a check ticked with no
 * value, a signature with no file, a stored is_failed disagreeing with the
 * response beside it. All of that went with the checklist in 224, and the
 * equivalent checks for forms live in jobForms. What is left is the one question
 * that is genuinely about headlines.
 */
export type HeadlineDrift = {
  /** Open jobs carrying no headline while the setting demands one. */
  missingHeadline: { jobId: number; documentNumber: string | null }[]
}

/** Drift between what was recorded and what the rules allow. Reports, never repairs. */
export async function reconcileJobHeadlines(siteId: number): Promise<HeadlineDrift> {
  const [missing, required] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT j.id, j.document_number FROM job_cards j
        WHERE j.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM job_card_headlines h WHERE h.job_card_id = j.id)`,
    ),
    headlineRequired(siteId),
  ])

  return {
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
