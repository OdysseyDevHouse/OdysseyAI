import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import { isClosed, type JobPriority, type JobStatusRole, type JobStatusTone } from '../jobStatusModel'

/**
 * Boards — saved views over statuses.
 *
 * ── A BOARD HOLDS NO JOBS ──────────────────────────────────────────────────
 *
 * The PRD answers this in its own Q&A: a job appears on more than one board
 * depending on whether its status is visible there. So there is no
 * job_cards.board_id, and that absence is the feature.
 *
 * A board FK would make a job belong to exactly one board, contradicting the
 * requirement, and would let somebody file a job wrongly — a job on the bench
 * sitting on the Sales board. Two boards naming the same status show the same
 * job, from one row, because nothing about membership was stored.
 *
 * ── THE TRAP THIS MODULE REPORTS ───────────────────────────────────────────
 *
 * A job in a status that NO board lists is invisible on every board. That is a
 * real way to lose work, so statusesOffEveryBoard() surfaces it on the setup
 * screen rather than the system quietly hiding it. Reports, never repairs —
 * the reconcileStock() stance.
 */

export type JobBoardLayout = 'kanban' | 'grid'

export type JobBoard = {
  id: number
  name: string
  slug: string
  layout: JobBoardLayout
  sortOrder: number
  isActive: boolean
  /** How many statuses this board draws as columns. */
  columnCount: number
}

export type BoardColumn = {
  statusId: number
  code: string
  name: string
  tone: JobStatusTone
  role: JobStatusRole
  columnOrder: number
  /** Derived from the role, never stored. A closed column is history. */
  isClosed: boolean
  cards: BoardCard[]
  /** Jobs in this status beyond the ones loaded, so the column can say so. */
  overflow: number
}

export type BoardCard = {
  id: number
  documentNumber: string | null
  title: string
  customerName: string | null
  ownerName: string
  priority: JobPriority
  dueAt: string | null
  /** Lines with nobody assigned to pay for them — the thing that leaks money. */
  pendingCount: number
}

export type BoardSaveResult = { ok: true; id: number } | { ok: false; error: string }
export type BoardActionResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

/**
 * How many cards a column loads.
 *
 * A board is a working surface, not a report: a column holding 400 jobs is not
 * something anybody drags through, and rendering all of them makes the page
 * unusable on the one screen that has to stay quick. The overflow count says
 * what is not shown and the grid view is where somebody goes to see it all.
 */
const CARDS_PER_COLUMN = 60

const SELECT_BOARD = `
  SELECT b.id, b.name, b.slug, b.layout, b.sort_order, b.is_active,
         (SELECT COUNT(*) FROM job_board_statuses s WHERE s.board_id = b.id) AS column_count
    FROM job_boards b`

function mapBoard(row: Row): JobBoard {
  return {
    id: Number(row.id),
    name: String(row.name),
    slug: String(row.slug),
    layout: String(row.layout) as JobBoardLayout,
    sortOrder: Number(row.sort_order),
    isActive: Number(row.is_active) === 1,
    columnCount: Number(row.column_count ?? 0),
  }
}

export async function listJobBoards(siteId: number, includeInactive = false): Promise<JobBoard[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_BOARD} ${includeInactive ? '' : 'WHERE b.is_active = 1'}
      ORDER BY b.sort_order, b.id`,
  )
  return rows.map(mapBoard)
}

export async function getJobBoard(siteId: number, slug: string): Promise<JobBoard | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_BOARD} WHERE b.slug = ?`, [slug])
  return row ? mapBoard(row) : null
}

/** The first active board, for /jobs/board with no slug. */
export async function defaultJobBoard(siteId: number): Promise<JobBoard | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_BOARD} WHERE b.is_active = 1 ORDER BY b.sort_order, b.id LIMIT 1`,
  )
  return row ? mapBoard(row) : null
}

/**
 * A board, drawn.
 *
 * Two queries rather than one per column: the columns, then every card across
 * all of them in one read, bucketed in memory. A board with nine columns is
 * otherwise ten round trips before anything renders.
 *
 * Closed columns are included — a workshop wants to see what it finished today —
 * but they load the most recent jobs rather than the oldest, because a Completed
 * column holding two years of work should show this week.
 */
export async function boardColumns(
  siteId: number,
  boardId: number,
  filter: { ownerUserId?: number | null; priority?: string } = {},
): Promise<BoardColumn[]> {
  const statusRows = await siteQuery<Row>(
    siteId,
    `SELECT s.id, s.code, s.name, s.tone, s.role, s.is_closed_stage, bs.column_order
       FROM job_board_statuses bs
       JOIN job_statuses s ON s.id = bs.status_id
      WHERE bs.board_id = ? AND s.is_active = 1
      ORDER BY bs.column_order, s.sort_order, s.id`,
    [boardId],
  )
  if (statusRows.length === 0) return []

  const statusIds = statusRows.map((r) => Number(r.id))
  const where: string[] = [`j.status_id IN (${statusIds.map(() => '?').join(',')})`]
  const params: (string | number)[] = [...statusIds]

  if (filter.ownerUserId !== undefined && filter.ownerUserId !== null) {
    where.push('j.owner_user_id = ?')
    params.push(filter.ownerUserId)
  }
  if (filter.priority) {
    where.push('j.priority = ?')
    params.push(filter.priority)
  }

  /*
   * One read for every card on the board. ROW_NUMBER caps each column
   * independently — a LIMIT on the whole set would let one busy column starve
   * the others of cards entirely.
   */
  const cardRows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM (
       SELECT j.id, j.status_id, j.document_number, j.title, j.customer_name,
              j.owner_name, j.priority, j.due_at,
              (SELECT COUNT(*) FROM job_card_lines l
                WHERE l.job_card_id = j.id AND l.billing_state = 'pending') AS pending_count,
              ROW_NUMBER() OVER (
                PARTITION BY j.status_id
                ORDER BY FIELD(j.priority,'urgent','high','normal','low'), j.due_at IS NULL, j.due_at, j.id DESC
              ) AS rn
         FROM job_cards j
        WHERE ${where.join(' AND ')}
     ) ranked
      WHERE rn <= ${CARDS_PER_COLUMN}`,
    params,
  )

  const totals = await siteQuery<Row>(
    siteId,
    `SELECT status_id, COUNT(*) AS total FROM job_cards j
      WHERE ${where.join(' AND ')} GROUP BY status_id`,
    params,
  )
  const totalByStatus = new Map(totals.map((r) => [Number(r.status_id), Number(r.total)]))

  const bucket = new Map<number, BoardCard[]>()
  for (const row of cardRows) {
    const statusId = Number(row.status_id)
    if (!bucket.has(statusId)) bucket.set(statusId, [])
    bucket.get(statusId)!.push({
      id: Number(row.id),
      documentNumber: row.document_number === null ? null : String(row.document_number),
      title: String(row.title),
      customerName: row.customer_name === null ? null : String(row.customer_name),
      ownerName: String(row.owner_name ?? ''),
      priority: String(row.priority) as JobPriority,
      dueAt: row.due_at === null ? null : String(row.due_at),
      pendingCount: Number(row.pending_count ?? 0),
    })
  }

  return statusRows.map((row) => {
    const statusId = Number(row.id)
    const cards = bucket.get(statusId) ?? []
    const role = String(row.role) as JobStatusRole
    return {
      statusId,
      code: String(row.code),
      name: String(row.name),
      tone: String(row.tone) as JobStatusTone,
      role,
      columnOrder: Number(row.column_order),
      // Role OR stage flag, matching mapJobCard and setStatus. A column marked
      // closed only by the flag would otherwise be styled as an open one.
      isClosed: isClosed(role) || Number(row.is_closed_stage) === 1,
      cards,
      overflow: Math.max(0, (totalByStatus.get(statusId) ?? 0) - cards.length),
    }
  })
}

/** Which statuses a board draws, for the setup screen. */
export async function boardStatusIds(siteId: number, boardId: number): Promise<number[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT status_id FROM job_board_statuses WHERE board_id = ? ORDER BY column_order`,
    [boardId],
  )
  return rows.map((r) => Number(r.status_id))
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'board'
  )
}

/** Pure, so the setup screen refuses the same things for the same reasons. */
export function validateJobBoard(
  input: { id: number | null; name: string; statusIds: readonly number[] },
  existing: readonly JobBoard[],
): string | null {
  const name = input.name.trim()
  if (!name) return 'A board needs a name.'
  if (name.length > 60) return 'That name is too long — 60 characters is the limit.'

  const clash = existing.find(
    (b) => b.id !== input.id && b.name.trim().toLowerCase() === name.toLowerCase(),
  )
  if (clash) return `There is already a board called ${clash.name}.`

  /*
   * A board with no columns renders an empty screen with no way to tell whether
   * that means "no work" or "misconfigured". Refusing it is kinder than showing
   * it.
   */
  if (input.statusIds.length === 0) return 'Choose at least one status for this board to show.'

  return null
}

export async function saveJobBoard(
  siteId: number,
  actor: Actor,
  input: {
    id: number | null
    name: string
    layout: JobBoardLayout
    isActive: boolean
    statusIds: readonly number[]
  },
): Promise<BoardSaveResult> {
  const existing = await listJobBoards(siteId, true)
  const refusal = validateJobBoard(input, existing)
  if (refusal) return { ok: false, error: refusal }

  const name = input.name.trim()

  return siteTransaction(siteId, async (tx) => {
    let boardId = input.id

    if (boardId === null) {
      let slug = slugify(name)
      if (existing.some((b) => b.slug === slug)) slug = `${slug}-${existing.length + 1}`
      const maxSort = existing.reduce((max, b) => Math.max(max, b.sortOrder), 0)
      const [res] = await tx.execute(
        `INSERT INTO job_boards (name, slug, layout, sort_order, is_active) VALUES (?, ?, ?, ?, ?)`,
        [name, slug, input.layout, maxSort + 10, input.isActive ? 1 : 0],
      )
      boardId = Number((res as { insertId: number }).insertId)
    } else {
      // The slug is frozen: it is in URLs people bookmark, and renaming a board
      // must relabel it rather than break the link.
      await tx.execute(`UPDATE job_boards SET name = ?, layout = ?, is_active = ? WHERE id = ?`, [
        name,
        input.layout,
        input.isActive ? 1 : 0,
        boardId,
      ])
    }

    /*
     * Replace the whole column set. The join table carries no history worth
     * preserving — it is configuration, and reconciling adds and removes
     * separately would be more code for the same result.
     */
    await tx.execute(`DELETE FROM job_board_statuses WHERE board_id = ?`, [boardId])
    let order = 10
    for (const statusId of input.statusIds) {
      await tx.execute(
        `INSERT INTO job_board_statuses (board_id, status_id, column_order) VALUES (?, ?, ?)`,
        [boardId, statusId, order],
      )
      order += 10
    }

    return boardId as number
  }).then(async (boardId) => {
    // Logged outside the transaction: this is configuration rather than money,
    // and logActivity swallows its own errors so a failed note cannot undo a
    // saved board.
    await logActivity(siteId, actor, {
      entity: 'job_card',
      entityId: null,
      action: input.id === null ? 'board_created' : 'board_updated',
      detail: `${name} — ${input.statusIds.length} ${input.statusIds.length === 1 ? 'column' : 'columns'}`,
    })
    return { ok: true as const, id: boardId }
  })
}

/**
 * Delete a board.
 *
 * Always allowed, unlike a status: a board holds no jobs, so removing one
 * changes what somebody looks at and nothing about the work. The last one is
 * refused only because /jobs/board would then have nothing to open.
 */
export async function deleteJobBoard(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<BoardActionResult> {
  const boards = await listJobBoards(siteId, true)
  const board = boards.find((b) => b.id === id)
  if (!board) return { ok: false, error: 'That board no longer exists.' }
  if (boards.length === 1) {
    return { ok: false, error: 'This is the only board. Rename it or change its columns instead.' }
  }

  await siteExecute(siteId, `DELETE FROM job_boards WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: null,
    action: 'board_deleted',
    detail: board.name,
  })
  return { ok: true }
}

export type OffBoardStatus = { statusId: number; name: string; jobCount: number }

/**
 * Active statuses that no board lists.
 *
 * Jobs in these are invisible on every board — reachable by URL and by the grid,
 * but not by the screen a dispatcher actually works from. Surfaced on the setup
 * screen with the job count, because "3 statuses appear on no board, and 12 jobs
 * are in them" is the sentence that prevents lost work.
 */
export async function statusesOffEveryBoard(siteId: number): Promise<OffBoardStatus[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT s.id, s.name,
            (SELECT COUNT(*) FROM job_cards j WHERE j.status_id = s.id) AS job_count
       FROM job_statuses s
      WHERE s.is_active = 1
        AND NOT EXISTS (SELECT 1 FROM job_board_statuses b WHERE b.status_id = s.id)
      ORDER BY s.sort_order`,
  )
  return rows.map((r) => ({
    statusId: Number(r.id),
    name: String(r.name),
    jobCount: Number(r.job_count ?? 0),
  }))
}
