import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { logActivity, type Actor } from './activityLog'

/**
 * A named set of filters over the job list.
 *
 * Section 37.2. See the header of 122_job_saved_views.sql for why a view stores
 * the QUESTION and never the answer, and why the filters are JSON in a schema
 * that otherwise prefers columns.
 *
 * ── VISIBILITY IS NOT PERMISSION ────────────────────────────────────────────
 *
 * A shared view is visible to everybody; what it RETURNS is still decided by
 * jobs.view / jobs.view_own on the list itself. Sharing a view called "All
 * overdue" with somebody who may only see their own work shows them their own
 * overdue jobs, not everybody else. If that were not true, a saved view would be
 * a way to widen access without touching the permissions screen.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * The filters a view may carry.
 *
 * Deliberately the same names the job list already reads from the URL, so a view
 * is genuinely "a saved URL" rather than a second vocabulary somebody has to
 * translate.
 */
export type ViewFilters = {
  state?: string
  status?: string
  priority?: string
  owner?: string
  q?: string
}

export type JobView = {
  id: number
  name: string
  filters: ViewFilters
  ownerUserId: number | null
  ownerName: string
  isShared: boolean
  isPinned: boolean
  sortOrder: number
}

export type ViewResult = { ok: true; id: number } | { ok: false; error: string }
export type ViewActionResult = { ok: true } | { ok: false; error: string }

/** Only the keys the list understands, and only as strings. */
const FILTER_KEYS: (keyof ViewFilters)[] = ['state', 'status', 'priority', 'owner', 'q']

/**
 * Narrows whatever arrives to the shape above.
 *
 * Applied on the way IN and on the way OUT. On the way in because the action is
 * the boundary and a JSON column will store anything; on the way out because a
 * row written by an older build, or by hand, must not reach the screen as a
 * filter nobody can clear.
 */
export function cleanFilters(raw: unknown): ViewFilters {
  if (raw === null || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const out: ViewFilters = {}
  for (const key of FILTER_KEYS) {
    const value = source[key]
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text === '') continue
    out[key] = text.slice(0, 120)
  }
  return out
}

function mapView(r: Row): JobView {
  /*
   * mysql2 returns a JSON column already parsed on some driver versions and as a
   * string on others. Handling both is not defensiveness for its own sake -- the
   * same query behaves differently across environments, and the failure is a
   * screen full of "[object Object]".
   */
  let filters: unknown = r.filters
  if (typeof filters === 'string') {
    try {
      filters = JSON.parse(filters)
    } catch {
      filters = {}
    }
  }
  return {
    id: Number(r.id),
    name: String(r.name),
    filters: cleanFilters(filters),
    ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
    ownerName: String(r.owner_name ?? ''),
    isShared: Number(r.is_shared) === 1,
    isPinned: Number(r.is_pinned) === 1,
    sortOrder: Number(r.sort_order),
  }
}

const SELECT_VIEW = `
  SELECT id, name, filters, owner_user_id, owner_name, is_shared, is_pinned, sort_order
    FROM job_saved_views
`

/**
 * What this person can see: their own views, plus every shared one.
 *
 * Tolerant of a site without migration 122 -- an empty list, never a thrown
 * error. The job list must still open on a site mid-migration.
 */
export async function listJobViews(siteId: number, userId: number): Promise<JobView[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `${SELECT_VIEW} WHERE owner_user_id = ? OR is_shared = 1
        ORDER BY is_pinned DESC, sort_order, name`,
      [userId],
    )
    return rows.map(mapView)
  } catch {
    return []
  }
}

export async function getJobView(siteId: number, id: number): Promise<JobView | null> {
  try {
    const row = await siteQueryOne<Row>(siteId, `${SELECT_VIEW} WHERE id = ?`, [id])
    return row ? mapView(row) : null
  } catch {
    return null
  }
}

/** Create or rename a view. */
export async function saveJobView(
  siteId: number,
  actor: Actor,
  input: {
    id: number | null
    name: string
    filters: ViewFilters
    isShared: boolean
    isPinned: boolean
  },
): Promise<ViewResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the view a name.' }
  if (name.length > 80) return { ok: false, error: 'That name is too long.' }

  const filters = cleanFilters(input.filters)
  if (Object.keys(filters).length === 0) {
    return {
      ok: false,
      error: 'Filter the list first — a view with no filters is just the job list.',
    }
  }

  /*
   * The shared-name check the unique key cannot make.
   *
   * uq_view_owner_name includes owner_user_id, which is NULLABLE -- and MySQL
   * treats NULLs as distinct, so two shared views could both be called "Overdue"
   * without the key noticing. (The same trap 083 hit with gl_mappings.) Checked
   * here instead.
   */
  if (input.isShared) {
    const clash = await siteQueryOne<Row>(
      siteId,
      `SELECT id FROM job_saved_views WHERE is_shared = 1 AND name = ? AND id <> ?`,
      [name, input.id ?? 0],
    )
    if (clash) {
      return { ok: false, error: `Somebody already shares a view called "${name}".` }
    }
  }

  try {
    if (input.id === null) {
      const res = await siteExecute(
        siteId,
        `INSERT INTO job_saved_views
           (name, filters, owner_user_id, owner_name, is_shared, is_pinned, sort_order)
         VALUES (?,?,?,?,?,?, COALESCE((SELECT n FROM (SELECT MAX(sort_order) + 1 AS n FROM job_saved_views) t), 0))`,
        [
          name,
          JSON.stringify(filters),
          actor.userId,
          actor.userName,
          input.isShared ? 1 : 0,
          input.isPinned ? 1 : 0,
        ],
      )
      await logActivity(siteId, actor, {
        entity: 'job_card',
        entityId: null,
        action: 'view_saved',
        detail: `Saved the view "${name}"`,
      })
      return { ok: true, id: res.insertId }
    }

    const existing = await getJobView(siteId, input.id)
    if (!existing) return { ok: false, error: 'That view no longer exists.' }
    // Somebody else's private view is not editable. A shared one is, on purpose:
    // shared means the site owns it.
    if (!existing.isShared && existing.ownerUserId !== actor.userId) {
      return { ok: false, error: 'That view belongs to somebody else.' }
    }

    await siteExecute(
      siteId,
      `UPDATE job_saved_views SET name = ?, filters = ?, is_shared = ?, is_pinned = ?
        WHERE id = ?`,
      [name, JSON.stringify(filters), input.isShared ? 1 : 0, input.isPinned ? 1 : 0, input.id],
    )
    return { ok: true, id: input.id }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ER_DUP_ENTRY') {
      return { ok: false, error: `You already have a view called "${name}".` }
    }
    if (code === 'ER_NO_SUCH_TABLE') {
      return { ok: false, error: 'Saved views are not set up on this site yet.' }
    }
    throw error
  }
}

export async function deleteJobView(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<ViewActionResult> {
  const view = await getJobView(siteId, id)
  if (!view) return { ok: false, error: 'That view no longer exists.' }
  if (!view.isShared && view.ownerUserId !== actor.userId) {
    return { ok: false, error: 'That view belongs to somebody else.' }
  }

  await siteExecute(siteId, `DELETE FROM job_saved_views WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: null,
    action: 'view_deleted',
    detail: `Deleted the view "${view.name}"`,
  })
  return { ok: true }
}

/** Turn a view into the query string the job list already understands. */
export function viewHref(view: JobView): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(view.filters)) {
    if (value) params.set(key, value)
  }
  // Named so a screen can tell which view is active without comparing filters.
  params.set('view', String(view.id))
  return `/jobs?${params.toString()}`
}

export type ViewDrift = {
  /**
   * A view filtering on a status that no longer exists.
   *
   * Reported rather than repaired. A view is somebody intent, and silently
   * rewriting it is worse than telling them it is broken -- they would go on
   * trusting a list that quietly stopped meaning what they set it up to mean.
   */
  brokenStatus: { id: number; name: string; ownerName: string; statusId: string }[]
}

/** Reports, never repairs. */
export async function reconcileJobViews(siteId: number): Promise<ViewDrift> {
  try {
    const [views, statuses] = await Promise.all([
      siteQuery<Row>(siteId, SELECT_VIEW),
      siteQuery<Row>(siteId, `SELECT id FROM job_statuses`),
    ])
    const live = new Set(statuses.map((s) => String(s.id)))
    return {
      brokenStatus: views
        .map(mapView)
        .filter((v) => v.filters.status && !live.has(v.filters.status))
        .map((v) => ({
          id: v.id,
          name: v.name,
          ownerName: v.ownerName || 'shared',
          statusId: v.filters.status ?? '',
        })),
    }
  } catch {
    return { brokenStatus: [] }
  }
}
