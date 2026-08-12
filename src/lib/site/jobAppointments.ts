import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { getSetting } from './settings'
import { statusForRole } from './jobStatuses'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABEL,
  APPOINTMENT_STATUS_TONE,
  appointmentNeedsReason,
  gapBetween,
  isLiveAppointment,
  overlaps,
  storedMillis,
  type AppointmentStatus,
} from '../jobStatusModel'

/**
 * When somebody is going, and who.
 *
 * ── ONE PREDICATE FOR "STILL BOOKED" ───────────────────────────────────────
 *
 * LIVE_APPOINTMENT below is the SQL half of isLiveAppointment(), and every query
 * that asks whether a job is scheduled uses it. That is deliberate: the PRD
 * requires a cancelled or completed appointment not to make a job count as
 * scheduled, and three queries spelling that rule three ways is how one of them
 * comes to disagree. stockHolds.ts makes the same move with LIVE_HOLD, for the
 * same reason.
 *
 * ── UNSCHEDULED IS DERIVED ─────────────────────────────────────────────────
 *
 * An open job with no live FUTURE appointment. Never stored: a date passing is not
 * an event anybody triggers, so a stored flag would need a nightly job to stay
 * true and would be wrong in between. Same argument as quoteState() for expiry
 * and isClosed() for open-versus-closed.
 *
 * ── CONFLICTS WARN, THEY DO NOT REFUSE ─────────────────────────────────────
 *
 * findConflicts() returns a list; booking proceeds anyway when an override reason
 * is given. That is the PRD's own answer — an authorised user may override, but the
 * reason must be captured and audited — and it is the right one. A dispatcher
 * double-booking somebody on purpose because two jobs are next door to each other
 * knows something the scheduler does not, and a hard refusal would make them
 * book it as a fake job instead, which is worse.
 */

export type ConflictKind =
  | 'overlap'
  | 'travel_gap'
  | 'on_leave'
  | 'outside_hours'
  | 'job_closed'

export type Conflict = {
  kind: ConflictKind
  /** Which assignee it concerns. Null for a conflict about the visit itself. */
  userId: number | null
  userName: string
  /** One sentence, ready to show. Written here so every surface says the same. */
  message: string
  /** The clashing appointment, where there is one. */
  otherAppointmentId?: number
  otherJobNumber?: string | null
}

export type AppointmentAssignee = {
  userId: number
  userName: string
  isLead: boolean
}

export type JobAppointment = {
  id: number
  jobCardId: number
  jobNumber: string | null
  jobTitle: string
  customerName: string | null
  visitNumber: number
  status: AppointmentStatus
  startsAt: string
  durationMinutes: number
  serviceAddressId: number | null
  serviceAddressName: string | null
  visitType: string | null
  notes: string | null
  travelStartedAt: string | null
  arrivedAt: string | null
  departedAt: string | null
  outcomeReason: string | null
  overrideReason: string | null
  userName: string
  assignees: AppointmentAssignee[]
  /** Derived: does this still count as a booking? */
  isLive: boolean
}

export type AppointmentInput = {
  id: number | null
  jobCardId: number
  startsAt: string
  durationMinutes: number
  serviceAddressId: number | null
  visitType: string | null
  notes: string | null
  assignees: { userId: number; userName: string; isLead: boolean }[]
  /** Required only when findConflicts() found something. */
  overrideReason?: string | null
}

export type AppointmentSaveResult =
  | { ok: true; id: number; conflicts: Conflict[] }
  | { ok: false; error: string; conflicts?: Conflict[] }

export type AppointmentActionResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

/**
 * The SQL half of isLiveAppointment(). Kept as one string so no query can spell
 * the rule differently.
 */
const LIVE_APPOINTMENT = `a.status NOT IN ('completed','cancelled','no_show')`

const SELECT_APPOINTMENT = `
  SELECT a.id, a.job_card_id, a.visit_number, a.status, a.starts_at, a.duration_minutes,
         a.service_address_id, a.visit_type, a.notes, a.travel_started_at, a.arrived_at,
         a.departed_at, a.outcome_reason, a.override_reason, a.user_name,
         j.document_number AS job_number, j.title AS job_title, j.customer_name,
         ad.name AS address_name
    FROM job_card_appointments a
    JOIN job_cards j            ON j.id = a.job_card_id
    LEFT JOIN service_addresses ad ON ad.id = a.service_address_id`

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

/**
 * A DATETIME as a stable wall-clock string, `YYYY-MM-DDTHH:MM:SS`.
 *
 * ── WHY EVERY DATETIME GOES THROUGH THIS ───────────────────────────────────
 *
 * mysql2 hands back a Date, and `String(thatDate)` in Node yields a LOCALE
 * string — 'Wed Aug 12 2026 10:00:00 GMT+0200 (South Africa Standard Time)'.
 * Shipping that to the browser means every consumer has to re-parse a
 * human-readable format, and the one that mattered here parsed it to NaN.
 *
 * The pool sets the connection timezone to 'Z', so the UTC parts of that Date ARE
 * the stored wall clock. Reading them with getUTC* and re-formatting is what keeps
 * a 10:00 visit reading as 10:00 on a machine set to SAST, instead of 12:00.
 *
 * This is the same helper, for the same reason, as wallClock() in reservations.ts
 * — see its header, which records that `dateStrings` is not set for DATETIME so
 * this cannot be skipped.
 */
function wallClock(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') {
    // Defensive: a driver configured with dateStrings hands back
    // '2026-08-12 10:00:00'. Normalise to the same shape.
    return value.replace(' ', 'T').slice(0, 19)
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}` +
    `T${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
  )
}

/**
 * Minutes-since-epoch, which is what the pure overlap helpers take.
 *
 * Via wallClock first, so a driver Date and a bare string reach storedMillis in
 * one shape. Skipping that step is how the overlap check came to compare NaN and
 * silently report no conflicts while the query was returning the clashing row.
 */
function minutesOf(value: unknown): number {
  return Math.round(storedMillis(wallClock(value)) / 60_000)
}

function mapAppointment(row: Row, assignees: AppointmentAssignee[]): JobAppointment {
  const status = String(row.status) as AppointmentStatus
  return {
    id: Number(row.id),
    jobCardId: Number(row.job_card_id),
    jobNumber: text(row.job_number),
    jobTitle: String(row.job_title),
    customerName: text(row.customer_name),
    visitNumber: Number(row.visit_number),
    status,
    // Every DATETIME through wallClock — see its header for why String() is a trap.
    startsAt: wallClock(row.starts_at) ?? '',
    durationMinutes: Number(row.duration_minutes),
    serviceAddressId: row.service_address_id === null ? null : Number(row.service_address_id),
    serviceAddressName: text(row.address_name),
    visitType: text(row.visit_type),
    notes: text(row.notes),
    travelStartedAt: wallClock(row.travel_started_at),
    arrivedAt: wallClock(row.arrived_at),
    departedAt: wallClock(row.departed_at),
    outcomeReason: text(row.outcome_reason),
    overrideReason: text(row.override_reason),
    userName: String(row.user_name ?? ''),
    assignees,
    isLive: isLiveAppointment(status),
  }
}

async function assigneesFor(
  siteId: number,
  appointmentIds: readonly number[],
): Promise<Map<number, AppointmentAssignee[]>> {
  const map = new Map<number, AppointmentAssignee[]>()
  if (appointmentIds.length === 0) return map

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT appointment_id, user_id, user_name, is_lead
       FROM job_appointment_assignees
      WHERE appointment_id IN (${appointmentIds.map(() => '?').join(',')})
      ORDER BY is_lead DESC, user_name`,
    [...appointmentIds],
  )
  for (const row of rows) {
    const id = Number(row.appointment_id)
    if (!map.has(id)) map.set(id, [])
    map.get(id)!.push({
      userId: Number(row.user_id),
      userName: String(row.user_name ?? ''),
      isLead: Number(row.is_lead) === 1,
    })
  }
  return map
}

/** Every visit on a job, in the order they happen. */
export async function jobAppointments(siteId: number, jobId: number): Promise<JobAppointment[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_APPOINTMENT} WHERE a.job_card_id = ? ORDER BY a.starts_at, a.visit_number`,
    [jobId],
  )
  const assignees = await assigneesFor(
    siteId,
    rows.map((r) => Number(r.id)),
  )
  return rows.map((row) => mapAppointment(row, assignees.get(Number(row.id)) ?? []))
}

export async function getAppointment(siteId: number, id: number): Promise<JobAppointment | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_APPOINTMENT} WHERE a.id = ?`, [id])
  if (!row) return null
  const assignees = await assigneesFor(siteId, [id])
  return mapAppointment(row, assignees.get(id) ?? [])
}

/**
 * Everything booked on one day.
 *
 * The schedule screen's whole query. Cancelled and no-show visits are INCLUDED —
 * a dispatcher looking at today needs to see that the 10am fell through, and
 * hiding it would make the lane look free when somebody is still expecting a call.
 * `isLive` says which is which.
 */
export async function appointmentsOn(siteId: number, date: string): Promise<JobAppointment[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_APPOINTMENT}
      WHERE DATE(a.starts_at) = ?
      ORDER BY a.starts_at, a.id`,
    [date],
  )
  const assignees = await assigneesFor(
    siteId,
    rows.map((r) => Number(r.id)),
  )
  return rows.map((row) => mapAppointment(row, assignees.get(Number(row.id)) ?? []))
}

/**
 * Open jobs with no live future appointment.
 *
 * The PRD's Unscheduled tile, and it is deliberately a query rather than a column.
 * `>= NOW()` is what makes "future" mean future: a job whose only visit was last
 * Tuesday and never happened is unscheduled again, which is exactly the state
 * somebody needs to find.
 */
export async function unscheduledJobCount(siteId: number): Promise<number> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS total FROM job_cards j
      WHERE j.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM job_card_appointments a
           WHERE a.job_card_id = j.id AND ${LIVE_APPOINTMENT} AND a.starts_at >= NOW()
        )`,
  )
  return Number(row?.total ?? 0)
}

export async function unscheduledJobIds(siteId: number, limit = 200): Promise<number[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT j.id FROM job_cards j
      WHERE j.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM job_card_appointments a
           WHERE a.job_card_id = j.id AND ${LIVE_APPOINTMENT} AND a.starts_at >= NOW()
        )
      ORDER BY FIELD(j.priority,'urgent','high','normal','low'), j.reported_at
      LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
  )
  return rows.map((r) => Number(r.id))
}

/**
 * What is wrong with this booking.
 *
 * ── WHAT IS CHECKED, AND WHAT IS NOT ───────────────────────────────────────
 *
 * Overlap, travel gap, approved leave, outside working hours, and a closed job.
 *
 * NOT checked: skills and certifications (no such data exists), vehicles and
 * equipment (likewise), and real drive time between two addresses. That last one
 * is the PRD's headline scheduling example — 45 minutes between two towns making
 * a 30-minute gap impossible — and it needs a distance provider this app does not
 * have. So the gap check uses a FLAT allowance from settings, which catches the
 * case that actually bites (two visits booked back to back across town) without
 * inventing a figure per pair of addresses and calling it a measurement.
 *
 * The honest version of that is a setting somebody chooses, not a number the
 * system fabricates. When a provider arrives, this function is where it plugs in.
 */
export async function findConflicts(
  siteId: number,
  input: {
    appointmentId: number | null
    jobCardId: number
    startsAt: string
    durationMinutes: number
    assignees: readonly { userId: number; userName: string }[]
  },
): Promise<Conflict[]> {
  const conflicts: Conflict[] = []

  const start = minutesOf(input.startsAt)
  const mins = Math.max(1, input.durationMinutes)
  const day = String(input.startsAt).slice(0, 10)

  // ── The job itself ──────────────────────────────────────────────────────
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT status, document_number FROM job_cards WHERE id = ?`,
    [input.jobCardId],
  )
  if (job && String(job.status) !== 'open') {
    conflicts.push({
      kind: 'job_closed',
      userId: null,
      userName: '',
      message: `${job.document_number ?? 'This job'} is ${String(job.status)}. Booking a visit on it will not reopen it.`,
    })
  }

  // ── Working hours ───────────────────────────────────────────────────────
  const [dayStarts, dayEnds] = await Promise.all([
    getSetting(siteId, 'job_day_starts'),
    getSetting(siteId, 'job_day_ends'),
  ])
  const hhmm = (value: string) => {
    const [h, m] = value.split(':').map(Number)
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
  }
  const openFrom = hhmm(dayStarts)
  const openTo = hhmm(dayEnds)
  // Minute-of-day from the UTC wall clock, matching how the value was stored.
  const startOfDay = new Date(storedMillis(input.startsAt))
  const minuteOfDay = startOfDay.getUTCHours() * 60 + startOfDay.getUTCMinutes()

  if (openFrom !== null && openTo !== null) {
    if (minuteOfDay < openFrom || minuteOfDay + mins > openTo) {
      conflicts.push({
        kind: 'outside_hours',
        userId: null,
        userName: '',
        message: `This runs outside the working day (${dayStarts}–${dayEnds}).`,
      })
    }
  }

  if (input.assignees.length === 0) return conflicts

  const userIds = input.assignees.map((a) => a.userId)
  const placeholders = userIds.map(() => '?').join(',')

  // ── Other bookings for the same people, that day ────────────────────────
  const others = await siteQuery<Row>(
    siteId,
    `SELECT a.id, a.starts_at, a.duration_minutes, s.user_id, s.user_name,
            j.document_number AS job_number
       FROM job_appointment_assignees s
       JOIN job_card_appointments a ON a.id = s.appointment_id
       JOIN job_cards j             ON j.id = a.job_card_id
      WHERE s.user_id IN (${placeholders})
        AND ${LIVE_APPOINTMENT}
        AND DATE(a.starts_at) = ?
        AND a.id <> ?`,
    [...userIds, day, input.appointmentId ?? 0],
  )

  const gapAllowance = Number(await getSetting(siteId, 'job_travel_gap_minutes'))

  for (const row of others) {
    const otherStart = minutesOf(row.starts_at)
    const otherMins = Number(row.duration_minutes)
    const who = String(row.user_name ?? '')

    if (overlaps(start, mins, otherStart, otherMins)) {
      conflicts.push({
        kind: 'overlap',
        userId: Number(row.user_id),
        userName: who,
        message: `${who || 'That person'} is already booked on ${row.job_number ?? 'another job'} at that time.`,
        otherAppointmentId: Number(row.id),
        otherJobNumber: text(row.job_number),
      })
      continue
    }

    const gap = gapBetween(start, mins, otherStart, otherMins)
    if (gap !== null && Number.isFinite(gapAllowance) && gapAllowance > 0 && gap < gapAllowance) {
      conflicts.push({
        kind: 'travel_gap',
        userId: Number(row.user_id),
        userName: who,
        message: `Only ${gap} minute${gap === 1 ? '' : 's'} between this and ${row.job_number ?? 'another visit'} — ${gapAllowance} is the allowance for getting there.`,
        otherAppointmentId: Number(row.id),
        otherJobNumber: text(row.job_number),
      })
    }
  }

  // ── Approved leave ──────────────────────────────────────────────────────
  /*
   * Only APPROVED leave counts. A request somebody has not signed off is not yet
   * a fact about the day, and warning on it would train dispatchers to ignore the
   * warnings — which is the failure mode that makes a conflict checker worthless.
   *
   * Wrapped in a try: leave_requests arrived in 058 and this module must not stop
   * a site booking a visit because it has not run that migration. The same
   * defensive swallow reservedQtyFor uses for online holds, for the same reason.
   */
  try {
    const onLeave = await siteQuery<Row>(
      siteId,
      `SELECT user_id, user_name, leave_type_name, period_from, period_to
         FROM leave_requests
        WHERE user_id IN (${placeholders})
          AND status = 'approved'
          AND ? BETWEEN period_from AND period_to`,
      [...userIds, day],
    )
    for (const row of onLeave) {
      conflicts.push({
        kind: 'on_leave',
        userId: Number(row.user_id),
        userName: String(row.user_name ?? ''),
        message: `${String(row.user_name ?? 'That person')} is on approved ${String(row.leave_type_name ?? 'leave').toLowerCase()} that day.`,
      })
    }
  } catch {
    // No leave table on this site. Not a reason to refuse a booking.
  }

  return conflicts
}

/** Pure enough to run in the dialog: the shape checks, before any query. */
export function validateAppointment(input: AppointmentInput): string | null {
  if (!input.startsAt) return 'When is the visit?'
  const when = new Date(String(input.startsAt).replace(' ', 'T'))
  if (Number.isNaN(when.getTime())) return 'That is not a real date and time.'
  if (input.durationMinutes < 5) return 'A visit needs at least five minutes.'
  if (input.durationMinutes > 24 * 60) return 'A single visit cannot run longer than a day.'

  /*
   * A visit with nobody going is allowed, deliberately: booking the slot before
   * knowing who is free is how dispatchers actually work, and refusing would make
   * them invent an assignment they then forget to correct. It shows on the board
   * as unassigned, which is the flag that gets it fixed.
   */
  const leads = input.assignees.filter((a) => a.isLead)
  if (input.assignees.length > 1 && leads.length === 0) {
    return 'With two people going, say which one leads the visit.'
  }
  if (leads.length > 1) return 'Only one person can lead a visit.'

  return null
}

/**
 * Book or move a visit.
 *
 * Conflicts are RETURNED, not thrown: the first call reports them and the caller
 * decides. Passing an override reason on the second call books it anyway and puts
 * the reason on the row and in the activity log, which is what the PRD asks for.
 */
export async function saveAppointment(
  siteId: number,
  actor: Actor,
  input: AppointmentInput,
): Promise<AppointmentSaveResult> {
  const refusal = validateAppointment(input)
  if (refusal) return { ok: false, error: refusal }

  const conflicts = await findConflicts(siteId, {
    appointmentId: input.id,
    jobCardId: input.jobCardId,
    startsAt: input.startsAt,
    durationMinutes: input.durationMinutes,
    assignees: input.assignees,
  })

  if (conflicts.length > 0 && !input.overrideReason?.trim()) {
    return {
      ok: false,
      error:
        conflicts.length === 1
          ? conflicts[0].message
          : `${conflicts.length} problems with that slot.`,
      conflicts,
    }
  }

  const id = await siteTransaction(siteId, async (tx) => {
    let appointmentId = input.id

    if (appointmentId === null) {
      const [maxRow] = await tx.query<Row[]>(
        `SELECT COALESCE(MAX(visit_number), 0) AS n FROM job_card_appointments WHERE job_card_id = ?`,
        [input.jobCardId],
      )
      const visitNumber = Number(maxRow[0]?.n ?? 0) + 1

      const [res] = await tx.execute(
        `INSERT INTO job_card_appointments
           (job_card_id, visit_number, status, starts_at, duration_minutes,
            service_address_id, visit_type, notes, override_reason, user_id, user_name)
         VALUES (?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.jobCardId,
          visitNumber,
          input.startsAt,
          input.durationMinutes,
          input.serviceAddressId,
          text(input.visitType),
          text(input.notes),
          text(input.overrideReason ?? null),
          actor.userId,
          actor.userName.slice(0, 120),
        ],
      )
      appointmentId = Number((res as { insertId: number }).insertId)
    } else {
      await tx.execute(
        `UPDATE job_card_appointments
            SET starts_at = ?, duration_minutes = ?, service_address_id = ?,
                visit_type = ?, notes = ?,
                override_reason = COALESCE(?, override_reason)
          WHERE id = ?`,
        [
          input.startsAt,
          input.durationMinutes,
          input.serviceAddressId,
          text(input.visitType),
          text(input.notes),
          text(input.overrideReason ?? null),
          appointmentId,
        ],
      )
    }

    // Whole-set replacement, matching how the job's lines save: the dialog owns
    // the list and the server reconciles.
    await tx.execute(`DELETE FROM job_appointment_assignees WHERE appointment_id = ?`, [appointmentId])
    for (const person of input.assignees) {
      await tx.execute(
        `INSERT INTO job_appointment_assignees (appointment_id, user_id, user_name, is_lead)
         VALUES (?, ?, ?, ?)`,
        [appointmentId, person.userId, person.userName.slice(0, 120), person.isLead ? 1 : 0],
      )
    }

    /*
     * Booking a future visit advances a job that has not started.
     *
     * The PRD asks for this: creating a future appointment may move the job to
     * Scheduled. Only from `new` or `assigned` — a job already In Progress must
     * not be dragged backwards by booking a follow-up visit, which is precisely
     * the case that would make automation untrustworthy.
     *
     * `scheduled` is an ordinary status with no role, so this looks it up by CODE
     * and does nothing if the business deleted or renamed it. A missing status is
     * not a reason to refuse a booking.
     */
    const [jobRows] = await tx.query<Row[]>(
      `SELECT j.status, s.role FROM job_cards j JOIN job_statuses s ON s.id = j.status_id
        WHERE j.id = ?`,
      [input.jobCardId],
    )
    const role = String(jobRows[0]?.role ?? '')
    if ((role === 'new' || role === 'assigned') && storedMillis(input.startsAt) > Date.now()) {
      const [sched] = await tx.query<Row[]>(
        `SELECT id FROM job_statuses WHERE code = 'scheduled' AND is_active = 1 LIMIT 1`,
      )
      if (sched[0]) {
        await tx.execute(`UPDATE job_cards SET status_id = ?, status = 'open' WHERE id = ?`, [
          Number(sched[0].id),
          input.jobCardId,
        ])
      }
    }

    const who = input.assignees.map((a) => a.userName).filter(Boolean).join(', ')
    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: input.jobCardId,
      action: input.id === null ? 'visit_booked' : 'visit_moved',
      detail:
        `${String(input.startsAt).slice(0, 16).replace('T', ' ')} for ${input.durationMinutes} min` +
        (who ? ` — ${who}` : ' — nobody assigned yet') +
        (input.overrideReason?.trim()
          ? `. Booked over ${conflicts.length} warning${conflicts.length === 1 ? '' : 's'}: ${input.overrideReason.trim()}`
          : ''),
    })

    return appointmentId as number
  })

  return { ok: true, id, conflicts }
}

/**
 * Move a visit through its lifecycle.
 *
 * The timestamps are stamped here rather than asked for, because the whole value
 * of an arrival time is that it is when somebody actually pressed the button. A
 * field somebody types is a field somebody rounds.
 */
export async function setAppointmentStatus(
  siteId: number,
  actor: Actor,
  appointmentId: number,
  status: AppointmentStatus,
  reason?: string,
): Promise<AppointmentActionResult> {
  if (!APPOINTMENT_STATUSES.includes(status)) {
    return { ok: false, error: 'That is not an appointment status.' }
  }
  if (appointmentNeedsReason(status) && !reason?.trim()) {
    return {
      ok: false,
      error:
        status === 'cancelled'
          ? 'Why was the visit called off?'
          : 'Say what happened — a missed visit with no reason is what the customer phones about.',
    }
  }

  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT a.id, a.job_card_id, a.status, a.visit_number, j.document_number
         FROM job_card_appointments a JOIN job_cards j ON j.id = a.job_card_id
        WHERE a.id = ?`,
      [appointmentId],
    )
    const appt = rows[0]
    if (!appt) return { ok: false as const, error: 'That visit no longer exists.' }

    const from = String(appt.status) as AppointmentStatus
    if (from === status) return { ok: true as const }

    /*
     * Stamped once, and never moved. A technician who presses On site twice has
     * arrived once, and overwriting the first time would quietly improve their
     * punctuality figures.
     */
    const stamps: string[] = []
    if (status === 'en_route') stamps.push('travel_started_at = COALESCE(travel_started_at, NOW())')
    if (status === 'on_site') stamps.push('arrived_at = COALESCE(arrived_at, NOW())')
    if (status === 'completed') stamps.push('departed_at = COALESCE(departed_at, NOW())')

    await tx.execute(
      `UPDATE job_card_appointments
          SET status = ?, outcome_reason = ?${stamps.length ? ', ' + stamps.join(', ') : ''}
        WHERE id = ?`,
      [status, appointmentNeedsReason(status) ? (text(reason) ?? null) : null, appointmentId],
    )

    /*
     * A technician arriving starts the JOB, if it has not started.
     *
     * The PRD asks for Start Work to move a job to In Progress, and arriving on
     * site is the field equivalent.
     *
     * ── WHY THIS TESTS THE RECORD STATE, NOT THE ROLE ──────────────────────
     *
     * The obvious guard is "advance only from new, assigned or on_hold". It is
     * wrong, and the way it fails is instructive: booking the visit has ALREADY
     * moved the job to Scheduled, which is an ordinary status with no role at all.
     * So the job a technician actually arrives at is precisely the one the
     * role-based list excludes.
     *
     * What must be protected is narrower than it looked. Do not advance a job that
     * is finished (`closed`), called off (`cancelled`), or already underway. Every
     * other open state — however the business named it — is a job somebody is
     * arriving at, and arriving means work has begun.
     */
    if (status === 'on_site') {
      const [jobRows] = await tx.query<Row[]>(
        `SELECT j.status, s.role FROM job_cards j JOIN job_statuses s ON s.id = j.status_id
          WHERE j.id = ?`,
        [Number(appt.job_card_id)],
      )
      const role = String(jobRows[0]?.role ?? '')
      const recordState = String(jobRows[0]?.status ?? '')
      if (recordState === 'open' && role !== 'in_progress') {
        const inProgress = await statusForRole(siteId, 'in_progress', tx)
        if (inProgress) {
          await tx.execute(
            `UPDATE job_cards
                SET status_id = ?, status = 'open', started_at = COALESCE(started_at, NOW())
              WHERE id = ?`,
            [inProgress.id, Number(appt.job_card_id)],
          )
        }
      }
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: Number(appt.job_card_id),
      action: 'visit_status',
      detail:
        `Visit ${appt.visit_number} — ${APPOINTMENT_STATUS_LABEL[status]}` +
        (reason?.trim() ? `: ${reason.trim()}` : ''),
      changes: {
        visit: { from: APPOINTMENT_STATUS_LABEL[from], to: APPOINTMENT_STATUS_LABEL[status] },
      },
    })

    return { ok: true as const }
  })
}

/**
 * Remove a visit that should never have existed.
 *
 * Only one that has not happened: a visit somebody attended is a record of the
 * day, and the way to undo it is `cancelled` with a reason. Visit numbers are
 * renumbered so a job never reads "visit 1, visit 3".
 */
export async function deleteAppointment(
  siteId: number,
  actor: Actor,
  appointmentId: number,
): Promise<AppointmentActionResult> {
  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT id, job_card_id, status, visit_number, arrived_at FROM job_card_appointments WHERE id = ?`,
      [appointmentId],
    )
    const appt = rows[0]
    if (!appt) return { ok: false as const, error: 'That visit no longer exists.' }

    if (appt.arrived_at !== null || String(appt.status) === 'completed') {
      return {
        ok: false as const,
        error: 'Somebody attended this visit. Cancel it with a reason rather than deleting the record.',
      }
    }

    const jobId = Number(appt.job_card_id)
    await tx.execute(`DELETE FROM job_card_appointments WHERE id = ?`, [appointmentId])

    // Renumber what is left, in the order the visits happen.
    const [remaining] = await tx.query<Row[]>(
      `SELECT id FROM job_card_appointments WHERE job_card_id = ? ORDER BY starts_at, id`,
      [jobId],
    )
    let n = 1
    for (const row of remaining) {
      await tx.execute(`UPDATE job_card_appointments SET visit_number = ? WHERE id = ?`, [
        n,
        Number(row.id),
      ])
      n += 1
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'visit_deleted',
      detail: `Visit ${appt.visit_number} removed before it happened`,
    })

    return { ok: true as const }
  })
}

/** Re-exported so a server caller has one import. */
export {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABEL,
  APPOINTMENT_STATUS_TONE,
  appointmentNeedsReason,
  isLiveAppointment,
}
export type { AppointmentStatus }
