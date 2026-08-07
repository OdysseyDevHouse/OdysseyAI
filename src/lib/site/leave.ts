import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import {
  entitlementToDate,
  round2,
  workingDaysBetween,
  checkRequest,
  localDay,
  type LeaveType,
  type LeaveRequest,
  type LeaveBalance,
  type LedgerSource,
} from '../leaveModel'

export type {
  LeaveType,
  LeaveRequest,
  LeaveBalance,
  LeaveStatus,
  LedgerSource,
} from '../leaveModel'

/**
 * Leave — entitlement, requests, and what is left.
 *
 * ── THE BALANCE IS NEVER STORED ─────────────────────────────────────────
 *
 * It is SUM(days) over `leave_ledger`. A stored figure would be a number
 * nobody could explain the first time an employee disputes it, and the whole
 * value of a ledger is that every part of the answer is arguable on its own.
 *
 * ── ACCRUAL IS IDEMPOTENT ───────────────────────────────────────────────
 *
 * `accrueFor` computes the TOTAL a person should have to date and posts only
 * the difference. Running it twice, late, or for a back-dated hire lands on
 * the same number. The unique index on (user, type, date, source) is the
 * second line of defence — a job on a timer WILL run twice eventually.
 */

type TypeRow = RowDataPacket & {
  id: number
  name: string
  code: string
  is_paid: number
  accrual_method: LeaveType['accrualMethod']
  accrual_days: string | number
  cycle_months: number
  max_balance_days: string | number | null
  is_system: number
  is_active: number
  notes: string | null
}

function mapType(r: TypeRow): LeaveType {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    isPaid: !!r.is_paid,
    accrualMethod: r.accrual_method,
    accrualDays: toNum(r.accrual_days),
    cycleMonths: r.cycle_months,
    maxBalanceDays: r.max_balance_days === null ? null : toNum(r.max_balance_days),
    isSystem: !!r.is_system,
    isActive: !!r.is_active,
    notes: r.notes,
  }
}

export async function listLeaveTypes(siteId: number, activeOnly = false): Promise<LeaveType[]> {
  const rows = await siteQuery<TypeRow>(
    siteId,
    `SELECT * FROM leave_types ${activeOnly ? 'WHERE is_active = 1' : ''}
      ORDER BY sort_order ASC, name ASC`,
  )
  return rows.map(mapType)
}

/* ── Balances ──────────────────────────────────────────────────────────── */

/**
 * One person's balance per leave type.
 *
 * `pending` is approved leave that has not happened yet. It is deliberately
 * NOT in the ledger — a ledger entry says something occurred, and leave booked
 * for December has not. But it IS committed, so `available` subtracts it;
 * otherwise somebody books the same days twice.
 */
export async function balancesFor(siteId: number, userId: number): Promise<LeaveBalance[]> {
  const types = await listLeaveTypes(siteId, true)
  const today = localDay(new Date())

  const ledger = await siteQuery<
    RowDataPacket & { leave_type_id: number; taken: string; earned: string }
  >(
    siteId,
    `SELECT leave_type_id,
            SUM(CASE WHEN days < 0 THEN -days ELSE 0 END) AS taken,
            SUM(CASE WHEN days > 0 THEN days ELSE 0 END)  AS earned
       FROM leave_ledger WHERE user_id = ? GROUP BY leave_type_id`,
    [userId],
  )
  const byType = new Map(ledger.map((r) => [r.leave_type_id, r]))

  const upcoming = await siteQuery<RowDataPacket & { leave_type_id: number; days: string }>(
    siteId,
    `SELECT leave_type_id, SUM(days) AS days
       FROM leave_requests
      WHERE user_id = ? AND status = 'approved' AND period_from > ?
      GROUP BY leave_type_id`,
    [userId, today],
  )
  const pendingByType = new Map(upcoming.map((r) => [r.leave_type_id, toNum(r.days)]))

  return types.map((type) => {
    const row = byType.get(type.id)
    const accrued = toNum(row?.earned)
    const used = toNum(row?.taken)
    const balance = round2(accrued - used)
    const pending = pendingByType.get(type.id) ?? 0

    return {
      leaveTypeId: type.id,
      leaveTypeName: type.name,
      isPaid: type.isPaid,
      accrued,
      used,
      balance,
      pending,
      available: round2(balance - pending),
    }
  })
}

export type LedgerEntry = {
  id: number
  entryDate: string
  days: number
  source: LedgerSource
  note: string | null
  createdByName: string | null
}

/** The movements behind a balance — the answer to "why have I got eleven days". */
export async function ledgerFor(
  siteId: number,
  userId: number,
  leaveTypeId?: number,
): Promise<LedgerEntry[]> {
  const rows = await siteQuery<
    RowDataPacket & {
      id: number
      entry_date: string
      days: string
      source: LedgerSource
      note: string | null
      created_by_name: string | null
    }
  >(
    siteId,
    `SELECT id, entry_date, days, source, note, created_by_name
       FROM leave_ledger
      WHERE user_id = ? ${leaveTypeId ? 'AND leave_type_id = ?' : ''}
      ORDER BY entry_date DESC, id DESC
      LIMIT 500`,
    leaveTypeId ? [userId, leaveTypeId] : [userId],
  )
  return rows.map((r) => ({
    id: r.id,
    entryDate: localDay(r.entry_date),
    days: toNum(r.days),
    source: r.source,
    note: r.note,
    createdByName: r.created_by_name,
  }))
}

/* ── Accrual ───────────────────────────────────────────────────────────── */

export type AccrualResult = { ok: true; posted: number; people: number } | { ok: false; error: string }

/**
 * Brings everybody's entitlement up to date.
 *
 * Safe to run repeatedly — it posts the DIFFERENCE between what somebody
 * should have and what the ledger already shows, so a second run posts
 * nothing. Anybody with no hire date is skipped rather than accrued from an
 * assumed start: guessing would hand out leave nobody earned.
 */
export async function accrueAll(
  siteId: number,
  upTo: string,
  actor: { userId: number; userName: string },
): Promise<AccrualResult> {
  const types = (await listLeaveTypes(siteId, true)).filter((t) => t.accrualMethod !== 'none')
  if (!types.length) return { ok: true, posted: 0, people: 0 }

  const staff = await siteQuery<
    RowDataPacket & {
      user_id: number
      hired_on: string | null
      terminated_on: string | null
      leave_cycle_start: string | null
    }
  >(
    siteId,
    `SELECT user_id, hired_on, terminated_on, leave_cycle_start FROM user_employment`,
  )

  let posted = 0
  const touched = new Set<number>()

  for (const person of staff) {
    // The cycle start is what the entitlement is measured from — BCEA s20
    // runs from the start of employment unless a store sets a common cycle.
    const start = person.leave_cycle_start ?? person.hired_on
    if (!start) continue

    const startIso = localDay(start)
    // Somebody who has left stops accruing on their last day, not today.
    const effective =
      person.terminated_on && localDay(person.terminated_on) < upTo
        ? localDay(person.terminated_on)
        : upTo

    for (const type of types) {
      const owed = entitlementToDate(type, startIso, effective)
      if (owed <= 0) continue

      const already = await siteQueryOne<RowDataPacket & { total: string | null }>(
        siteId,
        `SELECT SUM(days) AS total FROM leave_ledger
          WHERE user_id = ? AND leave_type_id = ? AND source = 'accrual'`,
        [person.user_id, type.id],
      )
      const have = toNum(already?.total)
      let difference = round2(owed - have)
      if (difference <= 0) continue

      // A cap limits what accrues, never what somebody has already earned —
      // s20(4) requires accrued annual leave to be granted, and s40(b) to be
      // paid out on termination, so it cannot simply be erased here.
      if (type.maxBalanceDays !== null) {
        const room = round2(type.maxBalanceDays - have)
        if (room <= 0) continue
        difference = Math.min(difference, room)
      }

      try {
        await siteExecute(
          siteId,
          `INSERT INTO leave_ledger
             (user_id, leave_type_id, entry_date, days, source, note,
              created_by_user_id, created_by_name)
           VALUES (?,?,?,?, 'accrual', ?, ?, ?)`,
          [
            person.user_id,
            type.id,
            effective,
            difference.toFixed(2),
            `Accrued to ${effective}`,
            actor.userId,
            actor.userName,
          ],
        )
        posted++
        touched.add(person.user_id)
      } catch {
        // The unique index refused it — this exact accrual already ran today.
        // Not an error: it is the guard doing its job.
      }
    }
  }

  return { ok: true, posted, people: touched.size }
}

/* ── Requests ──────────────────────────────────────────────────────────── */

type RequestRow = RowDataPacket & {
  id: number
  user_id: number
  user_name: string
  leave_type_id: number
  leave_type_name: string
  period_from: string
  period_to: string
  days: string
  is_half_day: number
  status: LeaveRequest['status']
  reason: string | null
  decided_by_name: string | null
  decided_at: string | null
  decided_note: string | null
}

function mapRequest(r: RequestRow): LeaveRequest {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    leaveTypeId: r.leave_type_id,
    leaveTypeName: r.leave_type_name,
    periodFrom: localDay(r.period_from),
    periodTo: localDay(r.period_to),
    days: toNum(r.days),
    isHalfDay: !!r.is_half_day,
    status: r.status,
    reason: r.reason,
    decidedByName: r.decided_by_name,
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    decidedNote: r.decided_note,
  }
}

export async function listRequests(
  siteId: number,
  filter: { userId?: number; status?: LeaveRequest['status']; from?: string; to?: string } = {},
): Promise<LeaveRequest[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (filter.userId) {
    where.push('user_id = ?')
    params.push(filter.userId)
  }
  if (filter.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  if (filter.from && filter.to) {
    // Overlapping, not contained: leave spanning a month boundary belongs to
    // both months' views rather than falling out of each.
    where.push('period_from <= ? AND period_to >= ?')
    params.push(filter.to, filter.from)
  }

  const rows = await siteQuery<RequestRow>(
    siteId,
    `SELECT * FROM leave_requests
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY period_from DESC, id DESC
      LIMIT 500`,
    params,
  )
  return rows.map(mapRequest)
}

export type RequestInput = {
  userId: number
  leaveTypeId: number
  periodFrom: string
  periodTo: string
  isHalfDay: boolean
  reason: string | null
}

export type RequestResult = { ok: true; id: number; days: number } | { ok: false; error: string }

/**
 * Books leave.
 *
 * The days are counted HERE, from the store's working week, and stored — see
 * 058. Counting them on read would let a later change to the working week
 * silently restate leave already taken.
 *
 * `allowNegative` exists because a store genuinely does sometimes grant leave
 * in advance, and a system that refuses outright means somebody keeps a second
 * record in a notebook.
 */
export async function requestLeave(
  siteId: number,
  input: RequestInput,
  allowNegative = false,
): Promise<RequestResult> {
  if (input.periodTo < input.periodFrom) {
    return { ok: false, error: 'The end date is before the start date.' }
  }

  const type = await siteQueryOne<TypeRow>(
    siteId,
    'SELECT * FROM leave_types WHERE id = ? AND is_active = 1 LIMIT 1',
    [input.leaveTypeId],
  )
  if (!type) return { ok: false, error: 'That kind of leave is not available.' }

  const user = await siteQueryOne<RowDataPacket & { id: number; name: string }>(
    siteId,
    'SELECT id, name FROM users WHERE id = ? LIMIT 1',
    [input.userId],
  )
  if (!user) return { ok: false, error: 'That person no longer exists.' }

  const mapped = mapType(type)
  const days = input.isHalfDay
    ? 0.5
    : workingDaysBetween(input.periodFrom, input.periodTo)

  // Two half days across different dates is two requests, not one.
  if (input.isHalfDay && input.periodFrom !== input.periodTo) {
    return { ok: false, error: 'A half day covers one date. Book each separately.' }
  }

  const balances = await balancesFor(siteId, input.userId)
  const available = balances.find((b) => b.leaveTypeId === input.leaveTypeId)?.available ?? 0

  const refused = checkRequest(mapped, days, available, allowNegative)
  if (refused) return { ok: false, error: refused }

  // Overlapping leave is nearly always a double-booking rather than an
  // intention, and it would take the days twice.
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    `SELECT id FROM leave_requests
      WHERE user_id = ? AND status IN ('requested','approved')
        AND period_from <= ? AND period_to >= ?
      LIMIT 1`,
    [input.userId, input.periodTo, input.periodFrom],
  )
  if (clash) return { ok: false, error: 'That overlaps leave they have already booked.' }

  const res = await siteExecute(
    siteId,
    `INSERT INTO leave_requests
       (user_id, user_name, leave_type_id, leave_type_name, period_from, period_to,
        days, is_half_day, reason)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      input.userId,
      user.name,
      input.leaveTypeId,
      mapped.name,
      input.periodFrom,
      input.periodTo,
      days.toFixed(2),
      input.isHalfDay ? 1 : 0,
      input.reason?.trim() || null,
    ],
  )
  return { ok: true, id: res.insertId, days }
}

export type DecisionResult = { ok: true } | { ok: false; error: string }

/**
 * Approves a request and takes the days off the balance.
 *
 * Both in one transaction: an approval without its ledger entry gives somebody
 * time off they still appear to be owed, which is the mistake that shows up in
 * March when the balances are wrong and nobody knows why.
 */
export async function approveRequest(
  siteId: number,
  requestId: number,
  actor: { userId: number; userName: string },
  note: string | null = null,
): Promise<DecisionResult> {
  const request = await siteQueryOne<RequestRow>(
    siteId,
    'SELECT * FROM leave_requests WHERE id = ? LIMIT 1',
    [requestId],
  )
  if (!request) return { ok: false, error: 'That request no longer exists.' }
  if (request.status !== 'requested') {
    return { ok: false, error: `That request has already been ${request.status}.` }
  }

  const days = toNum(request.days)

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE leave_requests
          SET status = 'approved', decided_by_user_id = ?, decided_by_name = ?,
              decided_at = NOW(), decided_note = ?
        WHERE id = ?`,
      [actor.userId, actor.userName, note?.trim() || null, requestId],
    )

    await tx.execute(
      `INSERT INTO leave_ledger
         (user_id, leave_type_id, entry_date, days, source, request_id, note,
          created_by_user_id, created_by_name)
       VALUES (?,?,?,?, 'taken', ?, ?, ?, ?)`,
      [
        request.user_id,
        request.leave_type_id,
        localDay(request.period_from),
        (-days).toFixed(2),
        requestId,
        `${request.leave_type_name} ${localDay(request.period_from)} to ${localDay(request.period_to)}`,
        actor.userId,
        actor.userName,
      ],
    )
  })

  return { ok: true }
}

export async function declineRequest(
  siteId: number,
  requestId: number,
  actor: { userId: number; userName: string },
  note: string | null,
): Promise<DecisionResult> {
  const request = await siteQueryOne<RequestRow>(
    siteId,
    'SELECT status FROM leave_requests WHERE id = ? LIMIT 1',
    [requestId],
  )
  if (!request) return { ok: false, error: 'That request no longer exists.' }
  if (request.status !== 'requested') {
    return { ok: false, error: `That request has already been ${request.status}.` }
  }

  await siteExecute(
    siteId,
    `UPDATE leave_requests
        SET status = 'declined', decided_by_user_id = ?, decided_by_name = ?,
            decided_at = NOW(), decided_note = ?
      WHERE id = ?`,
    [actor.userId, actor.userName, note?.trim() || null, requestId],
  )
  return { ok: true }
}

/**
 * Cancels leave, giving the days back if they had been taken.
 *
 * The ledger entry is DELETED rather than reversed with an opposite movement.
 * A cancelled booking never happened, and a pair of +3/−3 rows on a statement
 * reads as a mistake somebody made twice rather than as leave that was called
 * off.
 */
export async function cancelRequest(
  siteId: number,
  requestId: number,
  actor: { userId: number; userName: string },
): Promise<DecisionResult> {
  const request = await siteQueryOne<RequestRow>(
    siteId,
    'SELECT * FROM leave_requests WHERE id = ? LIMIT 1',
    [requestId],
  )
  if (!request) return { ok: false, error: 'That request no longer exists.' }
  if (request.status === 'cancelled') {
    return { ok: false, error: 'That request is already cancelled.' }
  }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE leave_requests
          SET status = 'cancelled', decided_by_user_id = ?, decided_by_name = ?,
              decided_at = NOW()
        WHERE id = ?`,
      [actor.userId, actor.userName, requestId],
    )
    await tx.execute(`DELETE FROM leave_ledger WHERE request_id = ? AND source = 'taken'`, [
      requestId,
    ])
  })

  return { ok: true }
}

/** A manager correcting a balance by hand — a migration, or a goodwill day. */
export async function adjustBalance(
  siteId: number,
  userId: number,
  leaveTypeId: number,
  days: number,
  note: string,
  source: Extract<LedgerSource, 'adjustment' | 'opening' | 'payout' | 'forfeit'>,
  actor: { userId: number; userName: string },
): Promise<DecisionResult> {
  if (days === 0) return { ok: false, error: 'An adjustment of zero changes nothing.' }
  if (!note.trim()) {
    return { ok: false, error: 'Give a reason — it is what makes the balance explainable later.' }
  }

  // Same date and source twice would hit the unique index, so adjustments made
  // on one day are distinguished by note rather than being refused.
  await siteExecute(
    siteId,
    `INSERT INTO leave_ledger
       (user_id, leave_type_id, entry_date, days, source, note,
        created_by_user_id, created_by_name)
     VALUES (?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       days = days + VALUES(days),
       note = CONCAT(LEFT(note, 200), ' · ', LEFT(VALUES(note), 190))`,
    [
      userId,
      leaveTypeId,
      localDay(new Date()),
      days.toFixed(2),
      source,
      note.trim(),
      actor.userId,
      actor.userName,
    ],
  )
  return { ok: true }
}
