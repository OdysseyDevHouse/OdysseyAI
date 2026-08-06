import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import { getSetting } from './settings'
import {
  LOCK_SCOPES,
  SCOPE_LABELS,
  type LockScope,
  type LockType,
  type PeriodLock,
} from '../periodLockModel'

/**
 * Closing an accounting period.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Without it, someone posts a journal dated into March in July, after the VAT
 * return for March has been filed. Nothing refuses it, nothing reports it, and
 * the first anyone hears is from an auditor comparing the return against the
 * ledger. The cost of finding and unwinding that is enormous compared with the
 * cost of refusing the posting.
 *
 * ── RELATIONSHIP TO settings.vat_period_locked_to ────────────────────────
 *
 * That setting got there first and locks everything up to a single date. It is
 * still honoured — `isLocked` consults both — but it cannot say "February is
 * closed while March is open", and it records nothing about who closed a period
 * or why, which is the first question asked after a posting is refused.
 *
 * New code should call `guardPosting`. The setting remains as a site-wide floor
 * beneath the table.
 *
 * ── SOFT AND HARD ────────────────────────────────────────────────────────
 *
 * A hard lock refuses. A soft lock warns and allows, for the week between "we
 * think it is closed" and "the return is filed" — a real gap, and one that a
 * hard lock would simply be unlocked for, which teaches everyone that locks
 * come off on request.
 */

// The shape and labels live in the pure model so the Periods screen can read
// them without pulling the database layer into the browser bundle.
export { LOCK_SCOPES, SCOPE_LABELS }
export type { LockScope, LockType, PeriodLock } from '../periodLockModel'

type Row = RowDataPacket & Record<string, unknown>

function mapLock(r: Row): PeriodLock {
  const scope = String(r.scope) as LockScope
  return {
    id: Number(r.id),
    periodFrom: String(r.period_from),
    periodTo: String(r.period_to),
    lockType: String(r.lock_type) as LockType,
    scope,
    scopeLabel: SCOPE_LABELS[scope] ?? scope,
    reason: (r.reason as string | null) ?? null,
    lockedAt: r.locked_at as Date,
    lockedBy: String(r.locked_by ?? ''),
    unlockedAt: (r.unlocked_at as Date | null) ?? null,
    unlockedBy: (r.unlocked_by as string | null) ?? null,
    unlockReason: (r.unlock_reason as string | null) ?? null,
    active: r.unlocked_at === null,
  }
}

export async function listLocks(
  siteId: number,
  opts: { includeUnlocked?: boolean } = {},
): Promise<PeriodLock[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM period_locks
      ${opts.includeUnlocked ? '' : 'WHERE unlocked_at IS NULL'}
      ORDER BY period_from DESC, id DESC`,
  )
  return rows.map(mapLock)
}

export async function getLock(siteId: number, id: number): Promise<PeriodLock | null> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT * FROM period_locks WHERE id = ? LIMIT 1', [
    id,
  ])
  return row ? mapLock(row) : null
}

export type LockCheck = {
  locked: boolean
  /** True only for a hard lock — a soft lock allows the posting through. */
  refused: boolean
  lockType: LockType | null
  reason: string | null
  /** Ready to show. Null when nothing applies. */
  message: string | null
}

/**
 * Whether a date may be posted into, for a given kind of work.
 *
 * A lock scoped to 'all' catches everything; a narrower one catches only its
 * own scope, which is what lets a VAT period close while stock adjustments
 * continue. The site-wide setting is checked too and is always hard, matching
 * how sales has treated it since it was introduced.
 *
 * The strictest applicable lock wins: one hard lock anywhere over this date
 * refuses, however many soft ones also cover it.
 */
export async function isLocked(
  siteId: number,
  date: string,
  scope: Exclude<LockScope, 'all'> | 'all' = 'all',
): Promise<LockCheck> {
  const clear: LockCheck = {
    locked: false,
    refused: false,
    lockType: null,
    reason: null,
    message: null,
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return clear

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM period_locks
      WHERE unlocked_at IS NULL
        AND ? BETWEEN period_from AND period_to
        AND (scope = 'all' OR scope = ?)
      ORDER BY lock_type DESC`,
    [date, scope],
  )

  // The legacy site-wide floor. Always hard: that is how sales has enforced it.
  const legacyLockedTo = await getSetting(siteId, 'vat_period_locked_to')
  const legacyApplies = Boolean(legacyLockedTo) && date <= legacyLockedTo

  if (rows.length === 0 && !legacyApplies) return clear

  const hard = rows.find((r) => String(r.lock_type) === 'hard')
  if (hard || legacyApplies) {
    const lock = hard ? mapLock(hard) : null
    const reason = lock?.reason ?? (legacyApplies ? 'The VAT period is closed.' : null)
    return {
      locked: true,
      refused: true,
      lockType: 'hard',
      reason,
      message: lock
        ? `${lock.periodFrom} to ${lock.periodTo} is closed${reason ? ` — ${reason}` : ''}. Post to an open period, or reopen it first.`
        : `Nothing on or before ${legacyLockedTo} may be posted — that period is closed.`,
    }
  }

  const soft = mapLock(rows[0])
  return {
    locked: true,
    refused: false,
    lockType: 'soft',
    reason: soft.reason,
    message: `${soft.periodFrom} to ${soft.periodTo} is being finalised${soft.reason ? ` — ${soft.reason}` : ''}. This posting is allowed, but check it belongs there.`,
  }
}

/**
 * The guard every posting path calls.
 *
 * Returns an error STRING or null, matching the shape validatePost() uses in
 * the ledgers, so wiring it in is one line at each call site rather than a new
 * result type to thread through.
 */
export async function guardPosting(
  siteId: number,
  date: string,
  scope: Exclude<LockScope, 'all'> | 'all' = 'all',
): Promise<string | null> {
  const check = await isLocked(siteId, date, scope)
  return check.refused ? (check.message ?? 'That period is closed.') : null
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type LockInput = {
  periodFrom: string
  periodTo: string
  lockType?: LockType
  scope?: LockScope
  reason?: string | null
}

export type LockResult = { ok: true; id: number } | { ok: false; error: string }

export async function lockPeriod(
  siteId: number,
  actor: Actor,
  input: LockInput,
): Promise<LockResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(input.periodTo)) {
    return { ok: false, error: 'Choose a valid period.' }
  }
  if (input.periodFrom > input.periodTo) {
    return { ok: false, error: 'The period starts after it ends.' }
  }

  const scope = input.scope ?? 'all'

  // An identical overlapping lock is almost always a double-submit rather than
  // an intention, and two locks saying the same thing make the audit trail
  // harder to read for no benefit.
  const overlap = await siteQueryOne<Row>(
    siteId,
    `SELECT id, period_from, period_to FROM period_locks
      WHERE unlocked_at IS NULL AND scope = ?
        AND period_from <= ? AND period_to >= ?
      LIMIT 1`,
    [scope, input.periodTo, input.periodFrom],
  )
  if (overlap) {
    return {
      ok: false,
      error: `${overlap.period_from} to ${overlap.period_to} is already locked for that scope.`,
    }
  }

  const result = await siteExecute(
    siteId,
    `INSERT INTO period_locks (period_from, period_to, lock_type, scope, reason, locked_by)
     VALUES (?,?,?,?,?,?)`,
    [
      input.periodFrom,
      input.periodTo,
      input.lockType ?? 'hard',
      scope,
      input.reason?.trim() || null,
      actor.userName.slice(0, 120),
    ],
  )
  const id = result.insertId

  await logActivity(siteId, actor, {
    entity: 'period',
    entityId: id,
    action: 'lock',
    detail: `Closed ${input.periodFrom} to ${input.periodTo} (${input.lockType ?? 'hard'}, ${SCOPE_LABELS[scope]})${input.reason ? ` — ${input.reason.trim()}` : ''}`,
  })

  return { ok: true, id }
}

/**
 * Reopens a period.
 *
 * The row is kept and stamped rather than deleted: "who reopened February, when
 * and why" is precisely what an auditor asks, and a DELETE cannot answer it. A
 * reason is required for the same reason.
 */
export async function unlockPeriod(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason?.trim()) return { ok: false, error: 'Give a reason for reopening the period.' }

  const lock = await getLock(siteId, id)
  if (!lock) return { ok: false, error: 'That lock no longer exists.' }
  if (!lock.active) return { ok: false, error: 'That period is already open.' }

  await siteExecute(
    siteId,
    `UPDATE period_locks
        SET unlocked_at = NOW(), unlocked_by = ?, unlock_reason = ?
      WHERE id = ?`,
    [actor.userName.slice(0, 120), reason.trim().slice(0, 190), id],
  )

  await logActivity(siteId, actor, {
    entity: 'period',
    entityId: id,
    action: 'unlock',
    detail: `Reopened ${lock.periodFrom} to ${lock.periodTo} — ${reason.trim()}`,
  })

  return { ok: true }
}

/**
 * Locks a whole calendar month, the usual case.
 *
 * Exists so the screen's common action is one click rather than two date
 * pickers that can be got wrong — an off-by-one on a month boundary leaves a
 * day open that everything then posts into.
 */
export async function lockMonth(
  siteId: number,
  actor: Actor,
  year: number,
  month: number,
  opts: { lockType?: LockType; scope?: LockScope; reason?: string | null } = {},
): Promise<LockResult> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { ok: false, error: 'That is not a valid year.' }
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, error: 'That is not a valid month.' }
  }

  const from = `${year}-${String(month).padStart(2, '0')}-01`
  // Day 0 of the next month is the last day of this one — no leap-year table.
  const last = new Date(year, month, 0).getDate()
  const to = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`

  return lockPeriod(siteId, actor, { periodFrom: from, periodTo: to, ...opts })
}
