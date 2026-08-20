import 'server-only'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { customerDbPrefix } from './customerDb'
import { nextDocumentNumber } from './sequences'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { getSettings } from './settings'
import { tradingHours, deadlinesFor } from './jobSla'
import { businessMinutesBetween, storedMillis, type TradingHours } from '../jobStatusModel'
import {
  clockTransition,
  validateLanes,
  type ClockAction,
  type LaneShape,
  type TicketPriority,
  type TicketSource,
  type TicketState,
} from '../ticketModel'

/**
 * Tickets: inbound support, timed by the lane it sits in.
 *
 * ── A TICKET IS NOT A JOB CARD ─────────────────────────────────────────────
 *
 * No lines, no billing state, no invoice link, no costing. That is what keeps
 * this a separate module rather than a second implementation of jobCards.ts:
 * the moment a ticket carries money, every rule about who pays for what would
 * exist twice and could disagree. A ticket that needs billing becomes a job,
 * through `job_card_id`, and the money happens there.
 *
 * ── THE LANE OWNS THE CLOCK ────────────────────────────────────────────────
 *
 * A job card times work with a manual timer somebody taps. A support desk does
 * not work that way, so here the LANE carries the action: dragging a ticket
 * into a lane flagged `start` opens a time segment, `pause` or `end` closes it.
 * Moving the card IS the timing act, which is why nobody has to remember.
 *
 * `moveTicket` below is the only function that changes a status, and it opens
 * or closes the segment IN THE SAME TRANSACTION. A move recorded without its
 * timing consequence — or a segment opened against a move that then failed — is
 * drift nothing on screen can explain.
 *
 * ── WHOSE TIME, AND IN WHAT HOURS ──────────────────────────────────────────
 *
 * The ASSIGNEE's, never the mover's: a dispatcher pushing twenty cards across
 * the board must not appear to have done twenty tickets of work.
 *
 * Counted in BUSINESS hours, the same clock the SLA runs on. A ticket left open
 * over a weekend reads as the hours the doors were open, and the work figure and
 * the promise figure on one screen cannot disagree. The segments store real
 * instants; the minutes are derived on read, so changing the trading week
 * restates every total rather than leaving two incomparable eras.
 *
 * ── TICKET TIME IS NEVER BILLED ────────────────────────────────────────────
 *
 * Which is what makes the per-user cap safe to enforce in code. jobTime.ts:27
 * explains the contrast: job time carries an unrelaxable database constraint
 * precisely because an hour billed twice cannot be recovered. Nothing here is
 * billed, so a configurable cap that a race could occasionally exceed costs
 * nothing — and a generated column could not express "at most N" anyway.
 */

type Row = RowDataPacket & Record<string, unknown>

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A stored DATETIME as the wall clock it was written as.
 *
 * The same helper, for the same reason, as wallClock() in jobAppointments — the
 * pool sets the connection timezone to 'Z', so String(driverDate) is a LOCALE
 * string and the naive `+ 'Z'` fix yields NaN. Copied rather than shared
 * because every module here keeps its own; see that header for the account.
 */
function wallClock(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return value.replace(' ', 'T').slice(0, 19)
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}` +
    `T${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
  )
}

/* ── Lanes ─────────────────────────────────────────────────────────────────── */

export type TicketLane = {
  id: number
  code: string
  name: string
  tone: string
  sortOrder: number
  clock: ClockAction
  isLanding: boolean
  isClosedStage: boolean
  isCancelledStage: boolean
  isSystem: boolean
  isActive: boolean
  /** How many live tickets sit here. What makes deleting a lane refusable. */
  ticketCount: number
}

const mapLane = (r: Row): TicketLane => ({
  id: Number(r.id),
  code: String(r.code),
  name: String(r.name),
  tone: String(r.tone),
  sortOrder: Number(r.sort_order),
  clock: String(r.clock) as ClockAction,
  isLanding: Number(r.is_landing) === 1,
  isClosedStage: Number(r.is_closed_stage) === 1,
  isCancelledStage: Number(r.is_cancelled_stage) === 1,
  isSystem: Number(r.is_system) === 1,
  isActive: Number(r.is_active) === 1,
  ticketCount: Number(r.ticket_count ?? 0),
})

export async function listLanes(
  siteId: number,
  includeInactive = true,
): Promise<TicketLane[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT s.*, (SELECT COUNT(*) FROM tickets t WHERE t.status_id = s.id) AS ticket_count
       FROM ticket_statuses s
      ${includeInactive ? '' : 'WHERE s.is_active = 1'}
      ORDER BY s.sort_order, s.id`,
  ).catch(() => [])
  return rows.map(mapLane)
}

export type LaneResult = { ok: true; id: number } | { ok: false; error: string }
export type TicketActionResult = { ok: true } | { ok: false; error: string }

export type LaneInput = {
  id: number | null
  code: string
  name: string
  tone: string
  sortOrder: number
  clock: ClockAction
  isLanding: boolean
  isClosedStage: boolean
  isCancelledStage: boolean
  isActive: boolean
}

/**
 * Save a lane, keeping the three cardinalities true.
 *
 * ── THE EXCLUSIVE FLAGS ARE CLEARED FROM WHOEVER HAD THEM ──────────────────
 *
 * Setting `start` here takes it off the lane that had it, which is what the
 * screen promises in as many words: "Each flag belongs to one lane only —
 * setting it here takes it off the lane that had it."
 *
 * Done in the same transaction as the save, and NOT with a unique key, because
 * `''` must be allowed on many lanes and no index can say "unique except for
 * one value". `job_statuses` handles `role` the same way for the same reason.
 */
export async function saveLane(
  siteId: number,
  actor: Actor,
  input: LaneInput,
): Promise<LaneResult> {
  const code = input.code.trim()
  if (!code) return { ok: false, error: 'Give this lane a short code.' }
  if (!/^[a-z0-9_]{1,40}$/.test(code)) {
    return { ok: false, error: 'A code may only use lowercase letters, numbers and underscores.' }
  }
  if (!input.name.trim()) return { ok: false, error: 'Give it a name.' }

  return siteTransaction(siteId, async (tx) => {
    const [existing] = await tx.query<Row[]>(
      `SELECT id, code, is_system FROM ticket_statuses WHERE code = ?`,
      [code],
    )
    const clash = existing[0]
    if (clash && (input.id === null || Number(clash.id) !== input.id)) {
      return { ok: false as const, error: `${code} is already used by another lane.` }
    }

    let id = input.id
    if (id === null) {
      const [res] = await tx.execute<ResultSetHeader>(
        `INSERT INTO ticket_statuses
           (code, name, tone, sort_order, clock, is_landing, is_closed_stage,
            is_cancelled_stage, is_active)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          code,
          input.name.trim(),
          input.tone,
          input.sortOrder,
          input.clock,
          input.isLanding ? 1 : 0,
          input.isClosedStage ? 1 : 0,
          input.isCancelledStage ? 1 : 0,
          input.isActive ? 1 : 0,
        ],
      )
      id = Number(res.insertId)
    } else {
      await tx.execute(
        `UPDATE ticket_statuses
            SET code = ?, name = ?, tone = ?, sort_order = ?, clock = ?,
                is_landing = ?, is_closed_stage = ?, is_cancelled_stage = ?, is_active = ?
          WHERE id = ?`,
        [
          code,
          input.name.trim(),
          input.tone,
          input.sortOrder,
          input.clock,
          input.isLanding ? 1 : 0,
          input.isClosedStage ? 1 : 0,
          input.isCancelledStage ? 1 : 0,
          input.isActive ? 1 : 0,
          id,
        ],
      )
    }

    // The exclusive flags, taken off whoever else had them.
    if (input.clock !== '') {
      await tx.execute(`UPDATE ticket_statuses SET clock = '' WHERE clock = ? AND id <> ?`, [
        input.clock,
        id,
      ])
    }
    if (input.isLanding) {
      await tx.execute(`UPDATE ticket_statuses SET is_landing = 0 WHERE id <> ?`, [id])
    }

    /*
     * And the board must still be usable afterwards. Checked AFTER the write,
     * inside the transaction, so the rules are applied to what the board will
     * actually look like rather than to what it looked like before.
     */
    const [after] = await tx.query<Row[]>(
      `SELECT id, clock, is_landing, is_closed_stage, is_cancelled_stage, is_active
         FROM ticket_statuses`,
    )
    const refusal = validateLanes(
      after.map(
        (r): LaneShape => ({
          id: Number(r.id),
          clock: String(r.clock) as ClockAction,
          isLanding: Number(r.is_landing) === 1,
          isClosedStage: Number(r.is_closed_stage) === 1,
          isCancelledStage: Number(r.is_cancelled_stage) === 1,
          isActive: Number(r.is_active) === 1,
        }),
      ),
    )
    if (refusal) return { ok: false as const, error: refusal }

    await logActivityTx(tx, actor, {
      entity: 'ticket_status',
      entityId: id!,
      action: input.id === null ? 'created' : 'updated',
      detail: input.name.trim(),
    })
    return { ok: true as const, id: id! }
  })
}

/** A lane holding tickets cannot go. Switching it off is the offered answer. */
export async function deleteLane(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<TicketActionResult> {
  const lane = await siteQueryOne<Row>(
    siteId,
    `SELECT s.id, s.name, s.is_system,
            (SELECT COUNT(*) FROM tickets t WHERE t.status_id = s.id) AS n
       FROM ticket_statuses s WHERE s.id = ?`,
    [id],
  )
  if (!lane) return { ok: false, error: 'That lane no longer exists.' }
  if (Number(lane.n) > 0) {
    return {
      ok: false,
      error: `${lane.name} still holds ${lane.n} ticket${Number(lane.n) === 1 ? '' : 's'}. Move them first, or switch the lane off.`,
    }
  }
  if (Number(lane.is_system) === 1) {
    return { ok: false, error: `${lane.name} is a built-in lane. Switch it off instead.` }
  }

  await siteExecute(siteId, `DELETE FROM ticket_statuses WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'ticket_status',
    entityId: id,
    action: 'deleted',
    detail: String(lane.name),
  })
  return { ok: true }
}

/* ── Tickets ───────────────────────────────────────────────────────────────── */

export type Ticket = {
  id: number
  documentNumber: string | null
  customerId: number | null
  customerName: string | null
  contactId: number | null
  subject: string
  description: string | null
  priority: TicketPriority
  statusId: number
  statusName: string
  statusTone: string
  clock: ClockAction
  state: TicketState
  isClosed: boolean
  assigneeUserId: number | null
  assigneeName: string
  source: TicketSource
  category: string | null
  reportedAt: string | null
  dueAt: string | null
  closedAt: string | null
  jobCardId: number | null
  jobNumber: string | null
  respondBy: string | null
  resolveBy: string | null
  respondedAt: string | null
  /** Business minutes worked, derived from the ledger. Never stored. */
  workedMinutes: number
  /** True while a segment is open — the card shows a running indicator. */
  isRunning: boolean
  createdAt: string | null
}

/**
 * A function rather than a constant: `customers` may live in the group
 * primary's database when the customer file is shared. `cdb` names it, and is
 * empty for a store that owns its own customers.
 */
const selectTicket = (cdb: string) => `
  SELECT t.*, s.name AS status_name, s.tone AS status_tone, s.clock,
         c.name AS customer_name, j.document_number AS job_number
    FROM tickets t
    JOIN ticket_statuses s ON s.id = t.status_id
    LEFT JOIN ${cdb}customers c  ON c.id = t.customer_id
    LEFT JOIN job_cards j  ON j.id = t.job_card_id`

function mapTicket(r: Row, workedMinutes = 0, isRunning = false): Ticket {
  return {
    id: Number(r.id),
    documentNumber: text(r.document_number),
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    customerName: text(r.customer_name),
    contactId: r.contact_id === null ? null : Number(r.contact_id),
    subject: String(r.subject),
    description: text(r.description),
    priority: String(r.priority) as TicketPriority,
    statusId: Number(r.status_id),
    statusName: String(r.status_name),
    statusTone: String(r.status_tone),
    clock: String(r.clock) as ClockAction,
    state: String(r.status) as TicketState,
    isClosed: String(r.status) !== 'open',
    assigneeUserId: r.assignee_user_id === null ? null : Number(r.assignee_user_id),
    assigneeName: String(r.assignee_name ?? ''),
    source: String(r.source) as TicketSource,
    category: text(r.category),
    reportedAt: wallClock(r.reported_at),
    dueAt: wallClock(r.due_at),
    closedAt: wallClock(r.closed_at),
    jobCardId: r.job_card_id === null ? null : Number(r.job_card_id),
    jobNumber: text(r.job_number),
    respondBy: wallClock(r.respond_by),
    resolveBy: wallClock(r.resolve_by),
    respondedAt: wallClock(r.responded_at),
    workedMinutes,
    isRunning,
    createdAt: wallClock(r.created_at),
  }
}

/**
 * Business minutes worked on a set of tickets, from the ledger.
 *
 * ── DERIVED, ALWAYS ────────────────────────────────────────────────────────
 *
 * Storing a running total would freeze it against the trading week as it stood
 * at the time, so a business that changed its hours would end up with two eras
 * of incomparable numbers and nothing on screen saying which was which. The
 * same argument 113 makes for deriving breach.
 *
 * An OPEN segment counts up to now, which is what makes a running ticket's
 * figure move while somebody watches it.
 */
async function workedFor(
  siteId: number,
  ticketIds: readonly number[],
  hours: TradingHours,
): Promise<Map<number, { minutes: number; running: boolean }>> {
  const out = new Map<number, { minutes: number; running: boolean }>()
  if (ticketIds.length === 0) return out

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ticket_id, started_at, ended_at FROM ticket_time_entries
      WHERE ticket_id IN (${ticketIds.map(() => '?').join(',')})`,
    [...ticketIds],
  ).catch(() => [])

  const now = Date.now()
  for (const r of rows) {
    const id = Number(r.ticket_id)
    const from = storedMillis(wallClock(r.started_at))
    if (!Number.isFinite(from)) continue
    const endedAt = wallClock(r.ended_at)
    const to = endedAt === null ? now : storedMillis(endedAt)
    if (!Number.isFinite(to)) continue

    const prev = out.get(id) ?? { minutes: 0, running: false }
    out.set(id, {
      minutes: prev.minutes + businessMinutesBetween(from, to, hours),
      running: prev.running || endedAt === null,
    })
  }
  return out
}

export async function getTicket(siteId: number, id: number): Promise<Ticket | null> {
  const cdb = await customerDbPrefix(siteId)
  const row = await siteQueryOne<Row>(siteId, `${selectTicket(cdb)} WHERE t.id = ?`, [id])
  if (!row) return null
  const hours = await tradingHours(siteId)
  const worked = await workedFor(siteId, [id], hours)
  const w = worked.get(id)
  return mapTicket(row, Math.round(w?.minutes ?? 0), w?.running ?? false)
}

export type TicketFilter = {
  state?: TicketState | 'all'
  statusId?: number
  assigneeUserId?: number
  customerId?: number
  priority?: TicketPriority
  search?: string
  limit?: number
}

export async function listTickets(
  siteId: number,
  filter: TicketFilter = {},
): Promise<Ticket[]> {
  const cdb = await customerDbPrefix(siteId)
  const where: string[] = []
  const params: unknown[] = []

  if (filter.state && filter.state !== 'all') {
    where.push('t.status = ?')
    params.push(filter.state)
  }
  if (filter.statusId) {
    where.push('t.status_id = ?')
    params.push(filter.statusId)
  }
  if (filter.assigneeUserId) {
    where.push('t.assignee_user_id = ?')
    params.push(filter.assigneeUserId)
  }
  if (filter.customerId) {
    where.push('t.customer_id = ?')
    params.push(filter.customerId)
  }
  if (filter.priority) {
    where.push('t.priority = ?')
    params.push(filter.priority)
  }
  if (filter.search?.trim()) {
    where.push('(t.subject LIKE ? OR t.document_number LIKE ? OR t.description LIKE ?)')
    const like = `%${filter.search.trim()}%`
    params.push(like, like, like)
  }

  const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 500)))
  const rows = await siteQuery<Row>(
    siteId,
    `${selectTicket(cdb)}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY FIELD(t.priority,'urgent','high','normal','low'), t.reported_at DESC, t.id DESC
      LIMIT ${limit}`,
    params,
  ).catch(() => [])

  const hours = await tradingHours(siteId)
  const worked = await workedFor(siteId, rows.map((r) => Number(r.id)), hours)
  return rows.map((r) => {
    const w = worked.get(Number(r.id))
    return mapTicket(r, Math.round(w?.minutes ?? 0), w?.running ?? false)
  })
}

export type TicketInput = {
  id: number | null
  customerId: number | null
  contactId: number | null
  subject: string
  description: string | null
  priority: TicketPriority
  statusId: number | null
  assigneeUserId: number | null
  assigneeName: string | null
  source: TicketSource
  category: string | null
  dueAt: string | null
}

export type TicketSaveResult =
  | { ok: true; id: number; documentNumber: string | null }
  | { ok: false; error: string }

/** Pure, so the screen refuses what the action refuses. */
export function validateTicket(input: TicketInput): string | null {
  if (!input.subject.trim()) return 'Say what the ticket is about.'
  if (input.subject.trim().length > 190) return 'That subject is too long.'
  return null
}

/**
 * Create or update a ticket.
 *
 * A new ticket lands in the LANDING lane and takes its number there. The number
 * is claimed inside the transaction, like every other numbered record, so a
 * failed save cannot burn one.
 *
 * Deliberately does NOT move a ticket between lanes — `moveTicket` is the only
 * thing that changes a status, because a status change has a timing consequence
 * and two paths to it is two chances to forget the clock.
 */
export async function saveTicket(
  siteId: number,
  actor: Actor,
  input: TicketInput,
): Promise<TicketSaveResult> {
  const refusal = validateTicket(input)
  if (refusal) return { ok: false, error: refusal }

  return siteTransaction(siteId, async (tx) => {
    if (input.id !== null) {
      const [existing] = await tx.query<Row[]>(`SELECT id, status FROM tickets WHERE id = ?`, [
        input.id,
      ])
      if (!existing[0]) return { ok: false as const, error: 'That ticket no longer exists.' }

      await tx.execute(
        `UPDATE tickets
            SET customer_id = ?, contact_id = ?, subject = ?, description = ?, priority = ?,
                assignee_user_id = ?, assignee_name = ?, source = ?, category = ?, due_at = ?
          WHERE id = ?`,
        [
          input.customerId,
          input.contactId,
          input.subject.trim(),
          text(input.description),
          input.priority,
          input.assigneeUserId,
          (input.assigneeName ?? '').slice(0, 120),
          input.source,
          text(input.category),
          input.dueAt,
          input.id,
        ],
      )
      await logActivityTx(tx, actor, {
        entity: 'ticket',
        entityId: input.id,
        action: 'updated',
        detail: input.subject.trim(),
      })
      const [after] = await tx.query<Row[]>(`SELECT document_number FROM tickets WHERE id = ?`, [
        input.id,
      ])
      return {
        ok: true as const,
        id: input.id,
        documentNumber: text(after[0]?.document_number),
      }
    }

    // Where a new ticket lands. validateLanes guarantees exactly one.
    const [landingRows] = await tx.query<Row[]>(
      `SELECT id FROM ticket_statuses WHERE is_landing = 1 AND is_active = 1 LIMIT 1`,
    )
    const statusId = input.statusId ?? (landingRows[0] ? Number(landingRows[0].id) : null)
    if (statusId === null) {
      return {
        ok: false as const,
        error: 'No lane is set as where new tickets land. Set one up first.',
      }
    }

    const documentNumber = await nextDocumentNumber(tx, 'ticket')

    const [res] = await tx.execute<ResultSetHeader>(
      `INSERT INTO tickets
         (document_number, customer_id, contact_id, subject, description, priority,
          status_id, status, assignee_user_id, assignee_name, source, category,
          reported_at, due_at, user_id, user_name)
       VALUES (?,?,?,?,?,?,?, 'open', ?,?,?,?, NOW(), ?,?,?)`,
      [
        documentNumber,
        input.customerId,
        input.contactId,
        input.subject.trim(),
        text(input.description),
        input.priority,
        statusId,
        input.assigneeUserId,
        (input.assigneeName ?? '').slice(0, 120),
        input.source,
        text(input.category),
        input.dueAt,
        actor.userId,
        actor.userName.slice(0, 120),
      ],
    )
    const id = Number(res.insertId)

    await logActivityTx(tx, actor, {
      entity: 'ticket',
      entityId: id,
      action: 'created',
      detail: input.subject.trim(),
    })
    return { ok: true as const, id, documentNumber }
  })
}

/* ── Moving a ticket, which is also the timing act ─────────────────────────── */

export type MoveResult =
  | { ok: true; started: boolean; stopped: boolean }
  | { ok: false; error: string }

/** 0 means no cap. See 165 for why that is the default. */
export async function maxRunningPerUser(siteId: number): Promise<number> {
  const s = await getSettings(siteId, ['ticket_max_running_per_user']).catch(
    () => ({}) as Record<string, string>,
  )
  const n = Number(s.ticket_max_running_per_user ?? '0')
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Move a ticket to a lane, and do to its clock whatever that lane says.
 *
 * ── ONE TRANSACTION, DELIBERATELY ──────────────────────────────────────────
 *
 * The status change and the time segment commit together or not at all. A
 * ticket sitting in "On Hold" with a running clock — or in "In Progress" with
 * none — is drift that nothing on screen can explain, and it is exactly what a
 * two-step version produces the first time the second step fails.
 *
 * ── THE PER-USER CAP ───────────────────────────────────────────────────────
 *
 * Counted and inserted inside the same transaction, with the person's open rows
 * locked first (FOR UPDATE). Two drags a hundred milliseconds apart must not
 * both count one and both insert.
 *
 * This is a CHECK, not a schema guarantee, because no index can express "at
 * most N" — and it is safe only because ticket time is never billed. See the
 * module header for the contrast with job time.
 *
 * ── AN UNASSIGNED TICKET CANNOT ACCRUE TIME ────────────────────────────────
 *
 * Time belongs to the assignee, so a ticket with nobody on it has no one to
 * credit. Dragging one into a running lane is REFUSED and says why, rather than
 * moving it and quietly timing nothing — which is the failure somebody finds a
 * month later in a report they cannot reconcile.
 */
export async function moveTicket(
  siteId: number,
  actor: Actor,
  ticketId: number,
  toStatusId: number,
): Promise<MoveResult> {
  const cap = await maxRunningPerUser(siteId)

  return siteTransaction(siteId, async (tx) => {
    const [ticketRows] = await tx.query<Row[]>(
      `SELECT t.id, t.status, t.status_id, t.subject, t.assignee_user_id, t.assignee_name,
              t.responded_at, s.name AS status_name, s.clock
         FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id
        WHERE t.id = ?`,
      [ticketId],
    )
    const ticket = ticketRows[0]
    if (!ticket) return { ok: false as const, error: 'That ticket no longer exists.' }

    const [laneRows] = await tx.query<Row[]>(
      `SELECT id, name, clock, is_closed_stage, is_cancelled_stage, is_active
         FROM ticket_statuses WHERE id = ?`,
      [toStatusId],
    )
    const lane = laneRows[0]
    if (!lane) return { ok: false as const, error: 'That lane no longer exists.' }
    if (Number(lane.is_active) !== 1) {
      return { ok: false as const, error: `${String(lane.name)} has been switched off.` }
    }
    if (Number(ticket.status_id) === toStatusId) {
      return { ok: true as const, started: false, stopped: false }
    }

    const from = String(ticket.clock) as ClockAction
    const to = String(lane.clock) as ClockAction
    const { close, open } = clockTransition(from, to)

    const assigneeId =
      ticket.assignee_user_id === null ? null : Number(ticket.assignee_user_id)

    if (open && assigneeId === null) {
      return {
        ok: false as const,
        error: `${String(lane.name)} starts the clock, so the ticket needs somebody assigned to it first.`,
      }
    }

    /*
     * The cap, checked against what this person has open RIGHT NOW.
     *
     * FOR UPDATE locks those rows, so a second drag arriving mid-check waits
     * rather than counting the same state and passing too. Copied from
     * startJobTimer, which guards the same race.
     */
    if (open && cap > 0 && assigneeId !== null) {
      const [openRows] = await tx.query<Row[]>(
        `SELECT e.ticket_id, t.document_number, t.subject
           FROM ticket_time_entries e
           JOIN tickets t ON t.id = e.ticket_id
          WHERE e.user_id = ? AND e.ended_at IS NULL AND e.ticket_id <> ?
          FOR UPDATE`,
        [assigneeId, ticketId],
      )
      if (openRows.length >= cap) {
        // NAMES them, so somebody knows what to stop. "Limit reached" sends
        // them hunting through a board.
        const names = openRows
          .slice(0, 3)
          .map((r) => text(r.document_number) ?? String(r.subject))
          .join(', ')
        return {
          ok: false as const,
          error: `${String(ticket.assignee_name) || 'That person'} already has ${openRows.length} ticket${openRows.length === 1 ? '' : 's'} running: ${names}. Stop one first, or raise the limit under Setup.`,
        }
      }
    }

    if (close) {
      await tx.execute(
        `UPDATE ticket_time_entries
            SET ended_at = NOW(), to_status_id = ?
          WHERE ticket_id = ? AND ended_at IS NULL`,
        [toStatusId, ticketId],
      )
    }
    if (open) {
      await tx.execute(
        `INSERT INTO ticket_time_entries
           (ticket_id, user_id, user_name, started_at, from_status_id, to_status_id)
         VALUES (?,?,?, NOW(), ?, ?)`,
        [
          ticketId,
          assigneeId,
          String(ticket.assignee_name ?? '').slice(0, 120),
          Number(ticket.status_id),
          toStatusId,
        ],
      )
    }

    /*
     * The derived state. Cancelled wins over closed: a cancelled ticket IS
     * closed but was not done, and every report needs to tell those apart.
     */
    const state: TicketState =
      Number(lane.is_cancelled_stage) === 1
        ? 'cancelled'
        : Number(lane.is_closed_stage) === 1
          ? 'closed'
          : 'open'

    await tx.execute(
      `UPDATE tickets
          SET status_id = ?, status = ?,
              closed_at = ${state === 'closed' ? 'NOW()' : 'NULL'},
              cancelled_at = ${state === 'cancelled' ? 'NOW()' : 'NULL'}
        WHERE id = ?`,
      [toStatusId, state, ticketId],
    )

    /*
     * Moving OFF the landing lane is the first response, if nobody has recorded
     * one yet. That is what a support desk means by "somebody picked it up",
     * and it stops the SLA response clock without anybody having to remember a
     * second button.
     */
    if (ticket.responded_at === null && from === '' && to !== '') {
      await tx.execute(
        `UPDATE tickets SET responded_at = NOW(), responded_by_user_id = ? WHERE id = ?`,
        [actor.userId, ticketId],
      )
    }

    await logActivityTx(tx, actor, {
      entity: 'ticket',
      entityId: ticketId,
      action: 'status_changed',
      detail: String(lane.name),
      changes: { status: { from: String(ticket.status_name), to: String(lane.name) } },
    })

    return { ok: true as const, started: open, stopped: close }
  })
}

/**
 * Reassigning closes the open segment and opens a new one against the new
 * person.
 *
 * Otherwise a stretch of work that two people shared lands entirely on whoever
 * happens to hold the ticket at the end, which is exactly backwards.
 */
export async function assignTicket(
  siteId: number,
  actor: Actor,
  ticketId: number,
  userId: number | null,
  userName: string,
): Promise<TicketActionResult> {
  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT t.id, t.status, t.assignee_user_id, s.clock
         FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id
        WHERE t.id = ?`,
      [ticketId],
    )
    const ticket = rows[0]
    if (!ticket) return { ok: false as const, error: 'That ticket no longer exists.' }
    if (String(ticket.status) !== 'open') {
      return { ok: false as const, error: 'This ticket is closed, so it cannot be reassigned.' }
    }

    const running = String(ticket.clock) === 'start'

    // Whatever the outgoing person had open stops here.
    if (running) {
      await tx.execute(
        `UPDATE ticket_time_entries SET ended_at = NOW()
          WHERE ticket_id = ? AND ended_at IS NULL`,
        [ticketId],
      )
    }

    await tx.execute(
      `UPDATE tickets SET assignee_user_id = ?, assignee_name = ? WHERE id = ?`,
      [userId, userName.slice(0, 120), ticketId],
    )

    // And the incoming person starts a fresh one, if the lane runs the clock.
    if (running && userId !== null) {
      await tx.execute(
        `INSERT INTO ticket_time_entries (ticket_id, user_id, user_name, started_at)
         VALUES (?,?,?, NOW())`,
        [ticketId, userId, userName.slice(0, 120)],
      )
    }

    await logActivityTx(tx, actor, {
      entity: 'ticket',
      entityId: ticketId,
      action: 'assigned',
      detail: userName || 'Unassigned',
    })
    return { ok: true as const }
  })
}

/* ── The ledger, as a person reads it ──────────────────────────────────────── */

export type TimeSegment = {
  id: number
  userId: number | null
  userName: string
  startedAt: string | null
  endedAt: string | null
  /** Business minutes, derived. An open segment counts up to now. */
  minutes: number
  isRunning: boolean
  fromStatusName: string | null
  toStatusName: string | null
}

/**
 * Every segment on a ticket, newest first.
 *
 * This is what the "Time tracking" block on the detail screen shows, and it is
 * the whole reason for a ledger rather than a total: "3h 20m" answers one
 * question, and "Sarah 2h, then Tom 1h20 after the handover" answers the one a
 * manager actually asked.
 */
export async function ticketTime(siteId: number, ticketId: number): Promise<TimeSegment[]> {
  const [rows, hours] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT e.*, f.name AS from_name, t.name AS to_name
         FROM ticket_time_entries e
         LEFT JOIN ticket_statuses f ON f.id = e.from_status_id
         LEFT JOIN ticket_statuses t ON t.id = e.to_status_id
        WHERE e.ticket_id = ?
        ORDER BY e.started_at DESC, e.id DESC`,
      [ticketId],
    ).catch(() => []),
    tradingHours(siteId),
  ])

  const now = Date.now()
  return rows.map((r) => {
    const startedAt = wallClock(r.started_at)
    const endedAt = wallClock(r.ended_at)
    const from = storedMillis(startedAt)
    const to = endedAt === null ? now : storedMillis(endedAt)
    return {
      id: Number(r.id),
      userId: r.user_id === null ? null : Number(r.user_id),
      userName: String(r.user_name ?? ''),
      startedAt,
      endedAt,
      minutes:
        Number.isFinite(from) && Number.isFinite(to)
          ? Math.round(businessMinutesBetween(from, to, hours))
          : 0,
      isRunning: endedAt === null,
      fromStatusName: text(r.from_name),
      toStatusName: text(r.to_name),
    }
  })
}

/** What one person has running right now, for the cap indicator on a board. */
export async function runningFor(
  siteId: number,
  userId: number,
): Promise<{ ticketId: number; documentNumber: string | null; subject: string }[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT e.ticket_id, t.document_number, t.subject
       FROM ticket_time_entries e
       JOIN tickets t ON t.id = e.ticket_id
      WHERE e.user_id = ? AND e.ended_at IS NULL
      ORDER BY e.started_at`,
    [userId],
  ).catch(() => [])
  return rows.map((r) => ({
    ticketId: Number(r.ticket_id),
    documentNumber: text(r.document_number),
    subject: String(r.subject),
  }))
}

/**
 * Link a ticket to the job it became.
 *
 * The ticket stays a ticket — this is a reference, not a conversion. §3 says a
 * ticket "can be linked to a jobcard", and the link is navigable both ways so
 * neither record is the hidden one.
 */
export async function linkToJob(
  siteId: number,
  actor: Actor,
  ticketId: number,
  jobCardId: number | null,
): Promise<TicketActionResult> {
  const ticket = await siteQueryOne<Row>(siteId, `SELECT id FROM tickets WHERE id = ?`, [ticketId])
  if (!ticket) return { ok: false, error: 'That ticket no longer exists.' }

  if (jobCardId !== null) {
    const job = await siteQueryOne<Row>(
      siteId,
      `SELECT id, document_number FROM job_cards WHERE id = ?`,
      [jobCardId],
    )
    if (!job) return { ok: false, error: 'That job no longer exists.' }
  }

  await siteExecute(siteId, `UPDATE tickets SET job_card_id = ? WHERE id = ?`, [
    jobCardId,
    ticketId,
  ])
  await logActivity(siteId, actor, {
    entity: 'ticket',
    entityId: ticketId,
    action: jobCardId === null ? 'job_unlinked' : 'job_linked',
    detail: jobCardId === null ? 'Job link removed' : `Job #${jobCardId}`,
  })
  return { ok: true }
}

/* ── Reports, never repairs ────────────────────────────────────────────────── */

export type TicketDrift = {
  /**
   * A ticket whose open segment disagrees with the lane it is in.
   *
   * Either it sits in a running lane with no clock, or in a paused/ended lane
   * with one still going. `moveTicket` makes both impossible by doing the two
   * in one transaction — this bucket is what would catch it if that were ever
   * broken, or if somebody edited the tables by hand.
   */
  clockMismatch: { id: number; documentNumber: string | null; subject: string; lane: string; expected: string }[]
  /** Somebody over the cap. Lowering the setting cannot stop a running clock. */
  overCap: { userId: number; userName: string; running: number; cap: number }[]
  /** A claim row whose job or ticket has gone — 165 dropped the CASCADE. */
  orphanedEscalations: { id: number; recordType: string; recordId: number }[]
}

export async function reconcileTickets(siteId: number): Promise<TicketDrift> {
  const cap = await maxRunningPerUser(siteId)

  const [mismatch, over, orphans] = await Promise.all([
    /*
     * The two shapes that cannot both be true: a running lane with no open
     * segment, or a non-running lane with one.
     */
    siteQuery<Row>(
      siteId,
      `SELECT t.id, t.document_number, t.subject, s.name AS lane, s.clock,
              (SELECT COUNT(*) FROM ticket_time_entries e
                WHERE e.ticket_id = t.id AND e.ended_at IS NULL) AS open_count
         FROM tickets t JOIN ticket_statuses s ON s.id = t.status_id
        WHERE t.status = 'open'
       HAVING (s.clock = 'start' AND open_count = 0)
           OR (s.clock <> 'start' AND open_count > 0)
        LIMIT 500`,
    ).catch(() => []),
    cap === 0
      ? Promise.resolve([] as Row[])
      : siteQuery<Row>(
          siteId,
          `SELECT e.user_id, e.user_name, COUNT(*) AS n
             FROM ticket_time_entries e
            WHERE e.ended_at IS NULL AND e.user_id IS NOT NULL
            GROUP BY e.user_id, e.user_name
           HAVING n > ?`,
          [cap],
        ).catch(() => []),
    /*
     * 165 dropped fk_slaesc_job, because the column now holds a ticket id half
     * the time and a foreign key cannot point at two tables. So nothing cleans
     * these up, and a leaked claim would suppress a REAL escalation later —
     * silently, and in a different module. Hence a report.
     */
    siteQuery<Row>(
      siteId,
      `SELECT id, record_type, job_card_id FROM job_sla_escalations
        WHERE (record_type = 'job'
                 AND job_card_id NOT IN (SELECT id FROM job_cards))
           OR (record_type = 'ticket'
                 AND job_card_id NOT IN (SELECT id FROM tickets))
        LIMIT 500`,
    ).catch(() => []),
  ])

  return {
    clockMismatch: mismatch.map((r) => ({
      id: Number(r.id),
      documentNumber: text(r.document_number),
      subject: String(r.subject),
      lane: String(r.lane),
      expected:
        String(r.clock) === 'start' ? 'the clock should be running' : 'the clock should be stopped',
    })),
    overCap: over.map((r) => ({
      userId: Number(r.user_id),
      userName: String(r.user_name ?? ''),
      running: Number(r.n),
      cap,
    })),
    orphanedEscalations: orphans.map((r) => ({
      id: Number(r.id),
      recordType: String(r.record_type),
      recordId: Number(r.job_card_id),
    })),
  }
}
