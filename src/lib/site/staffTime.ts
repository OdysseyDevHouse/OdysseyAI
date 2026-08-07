import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { toNum } from '../decimals'
import { workedMinutes, type TimeEntry, type TimeSource } from '../timeModel'
import { signInWithPin } from './users'
import { capabilitiesForRole, can } from './permissions'
import { openShiftFor } from './shifts'

export type { TimeEntry, TimeSource } from '../timeModel'

/**
 * Clocking in and out.
 *
 * The PIN is the credential, exactly as it is for the till: most floor staff
 * are `pos_only` users with no login at all, and asking them for an email and
 * a password at 07:00 would mean nobody clocks in.
 *
 * ── WHAT MAKES THIS TRUSTWORTHY ─────────────────────────────────────────
 *
 * One open entry per person, enforced by a generated column and a unique index
 * rather than by a SELECT-then-INSERT that two taps can race through.
 *
 * A correction is never silent. `edit()` records who changed it, why, and what
 * the figures were before — BCEA section 31 requires accurate records, and a
 * time sheet a manager can quietly rewrite is one staff will not trust.
 */

type Row = RowDataPacket & {
  id: number
  user_id: number
  user_name: string
  started_at: string
  ended_at: string | null
  source: TimeSource
  terminal_id: number | null
  shift_id: number | null
  break_minutes: number
  note: string | null
  edited_by_name: string | null
  edited_reason: string | null
  approved_at: string | null
}

const SELECT = `
  SELECT t.id, t.user_id, t.user_name, t.started_at, t.ended_at, t.source,
         t.terminal_id, t.shift_id, t.break_minutes, t.note,
         t.edited_by_name, t.edited_reason, t.approved_at
    FROM staff_time_entries t
`

function mapRow(r: Row): TimeEntry {
  const startedAt = new Date(r.started_at).toISOString()
  const endedAt = r.ended_at ? new Date(r.ended_at).toISOString() : null
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    startedAt,
    endedAt,
    source: r.source,
    terminalId: r.terminal_id,
    shiftId: r.shift_id,
    breakMinutes: toNum(r.break_minutes),
    note: r.note,
    editedByName: r.edited_by_name,
    editedReason: r.edited_reason,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    minutes: workedMinutes(startedAt, endedAt, toNum(r.break_minutes)),
  }
}

/** Everyone currently on the clock, longest first so a forgotten one leads. */
export async function whoIsOnTheClock(siteId: number): Promise<TimeEntry[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT} WHERE t.ended_at IS NULL ORDER BY t.started_at ASC`,
  )
  return rows.map(mapRow)
}

/** One person's open entry, or null. */
export async function openEntryFor(siteId: number, userId: number): Promise<TimeEntry | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT} WHERE t.user_id = ? AND t.ended_at IS NULL LIMIT 1`,
    [userId],
  )
  return row ? mapRow(row) : null
}

/**
 * Entries overlapping a date range, inclusive both ends.
 *
 * Overlapping rather than starting inside it: a night shift that begins at
 * 22:00 on the 31st belongs to that month's timesheet, and a range test on
 * `started_at` alone would drop it from both months.
 */
export async function entriesBetween(
  siteId: number,
  from: string,
  to: string,
  userId?: number,
): Promise<TimeEntry[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT}
      WHERE t.started_at < DATE_ADD(?, INTERVAL 1 DAY)
        AND (t.ended_at IS NULL OR t.ended_at >= ?)
        ${userId ? 'AND t.user_id = ?' : ''}
      ORDER BY t.started_at ASC`,
    userId ? [to, from, userId] : [to, from],
  )
  return rows.map(mapRow)
}

export type ClockResult =
  | { ok: true; action: 'in' | 'out'; userName: string; entry: TimeEntry }
  | { ok: false; error: string }

/**
 * One PIN, one action: clock in if they are out, clock out if they are in.
 *
 * Deliberately not two buttons. At 07:00 with a queue behind them, asking
 * somebody to remember whether they are currently clocked in is a question the
 * system can answer itself — and getting it wrong produces a second open entry
 * or a refusal, both of which they then need a manager for.
 */
export async function clock(
  siteId: number,
  pin: string,
  terminalId: number | null,
): Promise<ClockResult> {
  const found = await signInWithPin(siteId, pin)
  if (!found.ok) return found

  const user = found.user

  // Clocking is its own permission. Somebody may be allowed to work a till
  // without being on the payroll — a temp covering an afternoon, an owner
  // helping out — and their hours are not what this records.
  const capabilities = await capabilitiesForRole(siteId, user.roleId)
  if (!can(capabilities, 'staff.clock')) {
    return { ok: false, error: `${user.name} is not set up to clock in.` }
  }

  const open = await openEntryFor(siteId, user.id)

  if (open) {
    const closed = await closeEntry(siteId, open.id)
    if (!closed) return { ok: false, error: 'That entry was already closed.' }
    return { ok: true, action: 'out', userName: user.name, entry: closed }
  }

  const entry = await openEntry(siteId, user.id, user.name, terminalId, 'pin')
  if (!entry) {
    // The unique index refused it, which means a second tap landed while the
    // first was still in flight. Saying so beats a duplicate-key stack trace.
    return { ok: false, error: `${user.name} is already clocked in.` }
  }
  return { ok: true, action: 'in', userName: user.name, entry }
}

/**
 * Starts an entry, or returns null if one is already open.
 *
 * The null comes from the UNIQUE index rather than from a prior SELECT: two
 * taps a hundred milliseconds apart would both pass a check-then-insert.
 */
async function openEntry(
  siteId: number,
  userId: number,
  userName: string,
  terminalId: number | null,
  source: TimeSource,
): Promise<TimeEntry | null> {
  // The cash-up shift open on this till right now, so the two can be shown
  // side by side later. Never the source of the hours — see 054.
  const shift = terminalId ? await openShiftFor(siteId, terminalId) : null

  try {
    const res = await siteExecute(
      siteId,
      `INSERT INTO staff_time_entries
         (user_id, user_name, started_at, source, terminal_id, shift_id)
       VALUES (?,?,NOW(),?,?,?)`,
      [userId, userName, source, terminalId, shift?.id ?? null],
    )
    const row = await siteQueryOne<Row>(siteId, `${SELECT} WHERE t.id = ?`, [res.insertId])
    return row ? mapRow(row) : null
  } catch {
    return null
  }
}

async function closeEntry(siteId: number, entryId: number): Promise<TimeEntry | null> {
  await siteExecute(
    siteId,
    'UPDATE staff_time_entries SET ended_at = NOW() WHERE id = ? AND ended_at IS NULL',
    [entryId],
  )
  const row = await siteQueryOne<Row>(siteId, `${SELECT} WHERE t.id = ?`, [entryId])
  return row ? mapRow(row) : null
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export type ManualEntry = {
  userId: number
  startedAt: string
  endedAt: string | null
  breakMinutes: number
  note: string | null
}

function validate(input: ManualEntry): string | null {
  if (!input.startedAt) return 'Enter a start time.'

  // Compared as dates. These two can arrive in different formats — one from a
  // datetime-local input, one round-tripped through MySQL — and a string
  // comparison between them is decided by punctuation rather than by time.
  const started = new Date(input.startedAt)
  if (Number.isNaN(started.getTime())) return 'That start time is not valid.'

  if (input.endedAt) {
    const ended = new Date(input.endedAt)
    if (Number.isNaN(ended.getTime())) return 'That end time is not valid.'
    if (ended <= started) return 'The end time is before the start time.'
  }
  if (input.breakMinutes < 0) return 'A break cannot be negative.'
  if (input.endedAt) {
    const worked = workedMinutes(input.startedAt, input.endedAt, 0) ?? 0
    if (input.breakMinutes > worked) {
      return 'The break is longer than the shift.'
    }
  }
  // A clock-in dated in the future is always a typo, and it would sit at the
  // top of "who is on the clock" until somebody noticed.
  if (new Date(input.startedAt) > new Date(Date.now() + 60_000)) {
    return 'That start time is in the future.'
  }
  return null
}

/** A manager entering a shift somebody never clocked. */
export async function createManual(
  siteId: number,
  input: ManualEntry,
  actor: { userId: number; userName: string },
): Promise<SaveResult> {
  const problem = validate(input)
  if (problem) return { ok: false, error: problem }

  const user = await siteQueryOne<RowDataPacket & { id: number; name: string }>(
    siteId,
    'SELECT id, name FROM users WHERE id = ? LIMIT 1',
    [input.userId],
  )
  if (!user) return { ok: false, error: 'That person no longer exists.' }

  if (!input.endedAt) {
    const open = await openEntryFor(siteId, input.userId)
    if (open) return { ok: false, error: `${user.name} is already clocked in.` }
  }

  try {
    const res = await siteExecute(
      siteId,
      `INSERT INTO staff_time_entries
         (user_id, user_name, started_at, ended_at, source, break_minutes, note,
          edited_by_user_id, edited_by_name, edited_at, edited_reason)
       VALUES (?,?,?,?,'manual',?,?,?,?,NOW(),'Entered by hand')`,
      [
        input.userId,
        user.name,
        input.startedAt,
        input.endedAt,
        input.breakMinutes,
        input.note?.trim() || null,
        actor.userId,
        actor.userName,
      ],
    )
    return { ok: true, id: res.insertId }
  } catch {
    return { ok: false, error: `${user.name} is already clocked in.` }
  }
}

/**
 * Amends an entry, keeping what it said before.
 *
 * The original times are stamped only on the FIRST edit. A second correction
 * must not overwrite them, or the trail records the last mistake rather than
 * what was actually clocked.
 */
export async function editEntry(
  siteId: number,
  entryId: number,
  input: { startedAt: string; endedAt: string | null; breakMinutes: number; note: string | null },
  reason: string,
  actor: { userId: number; userName: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason.trim()) {
    return { ok: false, error: 'Give a reason — it goes on the record beside the change.' }
  }

  const existing = await siteQueryOne<Row>(siteId, `${SELECT} WHERE t.id = ? LIMIT 1`, [entryId])
  if (!existing) return { ok: false, error: 'That entry no longer exists.' }
  if (existing.approved_at) {
    return { ok: false, error: 'That entry has been approved. Unapprove it before changing it.' }
  }

  const problem = validate({ ...input, userId: existing.user_id })
  if (problem) return { ok: false, error: problem }

  await siteExecute(
    siteId,
    `UPDATE staff_time_entries
        SET started_at = ?, ended_at = ?, break_minutes = ?, note = ?,
            edited_by_user_id = ?, edited_by_name = ?, edited_at = NOW(),
            edited_reason = ?,
            original_started_at = COALESCE(original_started_at, started_at),
            original_ended_at = COALESCE(original_ended_at, ended_at)
      WHERE id = ?`,
    [
      input.startedAt,
      input.endedAt,
      input.breakMinutes,
      input.note?.trim() || null,
      actor.userId,
      actor.userName,
      reason.trim(),
      entryId,
    ],
  )
  return { ok: true }
}

export async function deleteEntry(
  siteId: number,
  entryId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await siteQueryOne<Row>(siteId, `${SELECT} WHERE t.id = ? LIMIT 1`, [entryId])
  if (!existing) return { ok: false, error: 'That entry no longer exists.' }
  if (existing.approved_at) {
    return { ok: false, error: 'That entry has been approved and cannot be deleted.' }
  }

  await siteExecute(siteId, 'DELETE FROM staff_time_entries WHERE id = ?', [entryId])
  return { ok: true }
}

/**
 * Closes an entry somebody forgot, at a time a manager chooses.
 *
 * Separate from `editEntry` because the reason writes itself and the start time
 * is not in question — only when they actually left.
 */
export async function closeForgotten(
  siteId: number,
  entryId: number,
  endedAt: string,
  actor: { userId: number; userName: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await siteQueryOne<Row>(siteId, `${SELECT} WHERE t.id = ? LIMIT 1`, [entryId])
  if (!existing) return { ok: false, error: 'That entry no longer exists.' }
  if (existing.ended_at) return { ok: false, error: 'That entry is already closed.' }

  // Compared as DATES, not as strings. `started_at` comes back from MySQL in
  // one format and `endedAt` arrives from a caller in another — a string
  // comparison between '2026-08-06 08:00:00' and '2026-08-06T16:00:00.000Z'
  // is decided by the space sorting before the 'T', not by the times, and
  // silently refuses every close.
  const startedAt = new Date(existing.started_at)
  const ending = new Date(endedAt)
  if (Number.isNaN(ending.getTime())) {
    return { ok: false, error: 'That is not a valid time.' }
  }
  if (ending <= startedAt) {
    return { ok: false, error: 'The end time is before they clocked in.' }
  }

  await siteExecute(
    siteId,
    `UPDATE staff_time_entries
        SET ended_at = ?, edited_by_user_id = ?, edited_by_name = ?, edited_at = NOW(),
            edited_reason = 'Closed by a manager — no clock-out was recorded'
      WHERE id = ? AND ended_at IS NULL`,
    [endedAt, actor.userId, actor.userName, entryId],
  )
  return { ok: true }
}
