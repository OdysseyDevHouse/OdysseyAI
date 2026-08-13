import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import {
  REQUIRED_ROLES,
  ROLE_LABEL,
  isClosed,
  roleMeaning,
  type JobStatusRole,
  type JobStatusTone,
  type RequiredRole,
} from '../jobStatusModel'
import { logActivity, type Actor } from './activityLog'

/**
 * The job workflow, owned by the business.
 *
 * ── WHY STATUSES ARE ROWS AND PRIORITIES ARE NOT ───────────────────────────
 *
 * A fixed enum was one workshop's process. An IT support desk has four steps, an
 * air-conditioning installer has nine, and neither calls the last one the same
 * thing. How many steps there are and what each is called is a property of the
 * BUSINESS — the same argument 034 makes for online order statuses, and this is
 * a copy of that table and this model.
 *
 * Priority got the opposite answer: an ENUM. It has no workflow attached, no
 * notifications of its own and no vocabulary worth protecting. Everybody calls
 * the top one urgent.
 *
 * ── MEANING SURVIVES RENAMING ──────────────────────────────────────────────
 *
 * `role` is what the code looks for. A business renaming "In Progress" to "On
 * the bench" must stay free to, while `setStatus` still knows where a job goes
 * when work starts. The PRD names New, Assigned, In Progress and On Hold as
 * undeletable: those are roles, `is_system` refuses the delete, and
 * REQUIRED_ROLES refuses removing the last holder of one.
 *
 * ── OPEN VERSUS CLOSED IS NOT STORED HERE ──────────────────────────────────
 *
 * isClosed() in jobStatusModel.ts derives it from the role. There is no
 * is_closed column and no per-status switch, because a configurable one lets
 * somebody mark In Progress as closed and silently empty every open-jobs figure
 * in the app. See that function for the full argument.
 */

export type JobStatus = {
  id: number
  code: string
  name: string
  tone: JobStatusTone
  sortOrder: number
  role: JobStatusRole
  isSystem: boolean
  isActive: boolean
  /* ── Rules per stage (123). Section 10.1 of the PRD. ────────────────────── */
  /** Ask for a sentence when a job enters this stage. */
  requiresReason: boolean
  /**
   * Refuse the move while required checks are outstanding.
   *
   * NULL means "use the site setting", which is what every status created before
   * 123 carries — so nothing changed for a site that migrated and touched
   * nothing.
   */
  blocksOnIncomplete: boolean | null
  /** Who may move a job here. 'office' keeps a technician out of the billing stages. */
  audience: 'anyone' | 'office'
  /** Closed without claiming a role. See the header of 123. */
  isClosedStage: boolean
  /** Jobs sitting in it. Shown before offering to retire or delete one. */
  jobCount: number
}

export type JobStatusInput = {
  /** Null to create. */
  id: number | null
  name: string
  tone: JobStatusTone
  role: JobStatusRole
  isActive: boolean
  /* ── The rules, 123. All optional so an older caller behaves as before. ─── */
  requiresReason?: boolean
  /** null = fall back to the site setting. */
  blocksOnIncomplete?: boolean | null
  audience?: 'anyone' | 'office'
  isClosedStage?: boolean
}

export type StatusSaveResult = { ok: true; id: number } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

const SELECT_STATUS = `
  SELECT s.id, s.code, s.name, s.tone, s.sort_order, s.role, s.is_system, s.is_active,
         s.requires_reason, s.blocks_on_incomplete, s.audience, s.is_closed_stage,
         (SELECT COUNT(*) FROM job_cards j WHERE j.status_id = s.id) AS job_count
    FROM job_statuses s`

function mapStatus(row: Row): JobStatus {
  return {
    id: Number(row.id),
    code: String(row.code),
    name: String(row.name),
    tone: String(row.tone) as JobStatusTone,
    sortOrder: Number(row.sort_order),
    role: String(row.role) as JobStatusRole,
    isSystem: Number(row.is_system) === 1,
    isActive: Number(row.is_active) === 1,
    requiresReason: Number(row.requires_reason) === 1,
    // NULL is preserved rather than coerced: "not decided" and "decided no" are
    // different answers, and flattening them would silently switch the close
    // guard off for every status created before 123.
    blocksOnIncomplete:
      row.blocks_on_incomplete === null || row.blocks_on_incomplete === undefined
        ? null
        : Number(row.blocks_on_incomplete) === 1,
    audience: String(row.audience ?? 'anyone') as 'anyone' | 'office',
    isClosedStage: Number(row.is_closed_stage) === 1,
    jobCount: Number(row.job_count ?? 0),
  }
}

export async function listJobStatuses(siteId: number, includeInactive = true): Promise<JobStatus[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_STATUS} ${includeInactive ? '' : 'WHERE s.is_active = 1'}
      ORDER BY s.sort_order, s.id`,
  )
  return rows.map(mapStatus)
}

export async function getJobStatus(siteId: number, id: number): Promise<JobStatus | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_STATUS} WHERE s.id = ?`, [id])
  return row ? mapStatus(row) : null
}

/**
 * The status holding a given role, or null.
 *
 * This is how every automatic move finds its target without knowing the
 * business's vocabulary: assignOwner asks for 'assigned', closeJob asks for
 * 'completed'. Null is a real answer — a business may have retired the status
 * holding a role, and the caller decides whether that is fatal or simply means
 * "do not move it".
 */
export async function statusForRole(
  siteId: number,
  role: RequiredRole,
  tx?: PoolConnection,
): Promise<JobStatus | null> {
  const sql = `${SELECT_STATUS} WHERE s.role = ? AND s.is_active = 1 ORDER BY s.sort_order LIMIT 1`
  if (tx) {
    const [rows] = await tx.query<Row[]>(sql, [role])
    return rows[0] ? mapStatus(rows[0]) : null
  }
  const row = await siteQueryOne<Row>(siteId, sql, [role])
  return row ? mapStatus(row) : null
}

/** Where a brand-new job lands. */
export async function newJobStatusId(siteId: number, tx?: PoolConnection): Promise<number | null> {
  const status = await statusForRole(siteId, 'new', tx)
  return status?.id ?? null
}

/**
 * A URL-safe, stable handle generated from the name ONCE and then frozen.
 *
 * Jobs reference the id, so a rename relabels every job sitting in the status
 * rather than stranding it — which is why the code never changes after creation.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

/**
 * Validation, kept pure and separate so the screen refuses the same things for
 * the same reasons the server does.
 *
 * `existing` is the full list, needed because two of the three rules are about
 * the set rather than the row: a role may be held once, and the last holder of a
 * required role may not give it up.
 */
export function validateJobStatus(input: JobStatusInput, existing: readonly JobStatus[]): string | null {
  const name = input.name.trim()
  if (!name) return 'A status needs a name.'
  if (name.length > 60) return 'That name is too long — 60 characters is the limit.'

  const clash = existing.find(
    (s) => s.id !== input.id && s.name.trim().toLowerCase() === name.toLowerCase(),
  )
  if (clash) return `There is already a status called ${clash.name}.`

  const current = input.id === null ? null : (existing.find((s) => s.id === input.id) ?? null)

  if (input.role) {
    const holder = existing.find((s) => s.id !== input.id && s.role === input.role)
    if (holder) {
      return `${holder.name} already means ${roleMeaning(input.role)}. A job can only go to one place, so move that role off ${holder.name} first.`
    }
  }

  /*
   * A system status may be renamed, re-toned and reordered freely — that is the
   * whole point of separating name from role. What it may not do is give up its
   * role or be switched off, because REQUIRED_ROLES promises every one of the six
   * is reachable and the lifecycle reads them by role.
   */
  if (current?.isSystem) {
    if (current.role && input.role !== current.role) {
      return `${current.name} is how the system knows ${roleMeaning(current.role)}. Its name can change, but its meaning cannot.`
    }
    if (!input.isActive) {
      return `${current.name} cannot be switched off — ${roleMeaning(current.role)} has to be somewhere.`
    }
  }

  return null
}

export async function saveJobStatus(
  siteId: number,
  actor: Actor,
  input: JobStatusInput,
): Promise<StatusSaveResult> {
  const existing = await listJobStatuses(siteId)
  const refusal = validateJobStatus(input, existing)
  if (refusal) return { ok: false, error: refusal }

  const name = input.name.trim()

  if (input.id === null) {
    // Land it at the end of the pipeline. Reordering is a separate action, so
    // creating a status never silently reshuffles the board.
    const maxSort = existing.reduce((max, s) => Math.max(max, s.sortOrder), 0)
    let code = slugify(name) || 'status'
    if (existing.some((s) => s.code === code)) code = `${code}_${Date.now() % 100000}`

    const result = await siteExecute(
      siteId,
      `INSERT INTO job_statuses
         (code, name, tone, sort_order, role, is_system, is_active,
          requires_reason, blocks_on_incomplete, audience, is_closed_stage)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        code,
        name,
        input.tone,
        maxSort + 10,
        input.role,
        input.isActive ? 1 : 0,
        input.requiresReason ? 1 : 0,
        // undefined and null both mean "not decided", which is the site setting.
        input.blocksOnIncomplete === null || input.blocksOnIncomplete === undefined
          ? null
          : input.blocksOnIncomplete
            ? 1
            : 0,
        input.audience ?? 'anyone',
        input.isClosedStage ? 1 : 0,
      ],
    )
    const id = Number(result.insertId)
    await logActivity(siteId, actor, {
      entity: 'job_card',
      entityId: null,
      action: 'status_created',
      detail: name,
    })
    return { ok: true, id }
  }

  const before = existing.find((s) => s.id === input.id)
  if (!before) return { ok: false, error: 'That status no longer exists.' }

  await siteExecute(
    siteId,
    `UPDATE job_statuses
        SET name = ?, tone = ?, role = ?, is_active = ?,
            requires_reason = ?, blocks_on_incomplete = ?, audience = ?, is_closed_stage = ?
      WHERE id = ?`,
    [
      name,
      input.tone,
      input.role,
      input.isActive ? 1 : 0,
      input.requiresReason ? 1 : 0,
      input.blocksOnIncomplete === null || input.blocksOnIncomplete === undefined
        ? null
        : input.blocksOnIncomplete
          ? 1
          : 0,
      input.audience ?? 'anyone',
      input.isClosedStage ? 1 : 0,
      input.id,
    ],
  )
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: null,
    action: 'status_updated',
    detail: name,
  })
  return { ok: true, id: input.id }
}

/**
 * Delete a status.
 *
 * Three refusals, in order of how badly each would break things: a system status
 * is never deletable; the last holder of a required role would leave the
 * lifecycle with nowhere to send a job; and a status holding jobs would strand
 * them. The third is also enforced by fk_jcard_status RESTRICT — checked here
 * anyway so the user gets a sentence rather than a database error.
 */
export async function deleteJobStatus(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<StatusSaveResult> {
  const all = await listJobStatuses(siteId)
  const status = all.find((s) => s.id === id)
  if (!status) return { ok: false, error: 'That status no longer exists.' }

  if (status.isSystem) {
    return {
      ok: false,
      error: `${status.name} is one of the statuses the system needs — ${roleMeaning(status.role)}. It can be renamed but not deleted.`,
    }
  }

  if (status.role && (REQUIRED_ROLES as readonly string[]).includes(status.role)) {
    const others = all.filter((s) => s.id !== id && s.role === status.role)
    if (others.length === 0) {
      return {
        ok: false,
        error: `${status.name} is the only status that means ${roleMeaning(status.role)}. Give that meaning to another status first.`,
      }
    }
  }

  if (status.jobCount > 0) {
    return {
      ok: false,
      error: `${status.jobCount} ${status.jobCount === 1 ? 'job is' : 'jobs are'} in ${status.name}. Move them first, or switch the status off instead to keep their label.`,
    }
  }

  await siteExecute(siteId, `DELETE FROM job_statuses WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: null,
    action: 'status_deleted',
    detail: status.name,
  })
  return { ok: true, id }
}

/** Reorder the pipeline. Ids in the order the business wants them. */
export async function reorderJobStatuses(
  siteId: number,
  actor: Actor,
  ids: readonly number[],
): Promise<StatusSaveResult> {
  let sort = 10
  for (const id of ids) {
    await siteExecute(siteId, `UPDATE job_statuses SET sort_order = ? WHERE id = ?`, [sort, id])
    sort += 10
  }
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: null,
    action: 'statuses_reordered',
    detail: `${ids.length} statuses`,
  })
  return { ok: true, id: 0 }
}

/**
 * Which required roles nobody holds.
 *
 * Read by the setup screen so a business that has switched something off sees
 * what it has broken, rather than discovering it when a job cannot be closed.
 * Reports, never repairs.
 */
export async function missingRoles(siteId: number): Promise<RequiredRole[]> {
  const statuses = await listJobStatuses(siteId, false)
  const held = new Set(statuses.map((s) => s.role))
  return REQUIRED_ROLES.filter((role) => !held.has(role))
}

/** The label a refusal or a setup hint uses for a role. */
export function labelForRole(role: Exclude<JobStatusRole, ''>): string {
  return ROLE_LABEL[role]
}

/** Re-exported so a server caller has one import. */
export { isClosed, REQUIRED_ROLES, ROLE_LABEL, roleMeaning }
export type { JobStatusRole, JobStatusTone, RequiredRole }
