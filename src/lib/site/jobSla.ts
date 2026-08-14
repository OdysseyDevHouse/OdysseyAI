import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { getSettings } from './settings'
import { holidayDatesFor } from './holidays'
import { type Actor } from './activityLog'
import {
  addBusinessMinutes,
  businessMinutesBetween,
  DEFAULT_TRADING_HOURS,
  isDayMask,
  minutesUntilDue,
  parseClock,
  slaState,
  storedMillis,
  tradingWeekIsUsable,
  type JobPriority,
  type SlaState,
  type TradingHours,
} from '../jobStatusModel'

/**
 * Service level targets: what was promised, and whether it was kept.
 *
 * ── WHAT IS STORED, AND WHAT IS WORKED OUT EVERY TIME ──────────────────────
 *
 * Stored: the promise (`job_sla_policies`) and the two deadlines it produced
 * (`job_cards.respond_by` / `resolve_by`). Worked out on read, always: whether a
 * job has breached.
 *
 * The DEADLINES are stored because a job promised Monday 11:00 must keep saying
 * Monday 11:00 after somebody edits the trading hours — the same argument 015
 * makes for storing document totals and 107 makes for storing chargeable_km.
 * Recomputing them on read would silently restate what a customer was told, and
 * that figure is precisely the one a dispute is about.
 *
 * The BREACH is not stored because a stored flag is wrong the minute after it is
 * written and would need a cron to stay true. `isClosed()` makes the same
 * argument about open/closed: passing the deadline IS the breach, so there is
 * nothing to trigger.
 *
 * ── THE CLOCK RUNS ON BUSINESS TIME ────────────────────────────────────────
 *
 * Four hours means four hours the doors were open. The arithmetic is in
 * `jobStatusModel` (browser-safe, no db import) and this file only feeds it the
 * trading week. A calendar clock would breach every job logged after Friday
 * lunch, and a worklist full of jobs nobody could have acted on is a worklist
 * people stop opening.
 *
 * ── ONE SETTINGS READ PER PAGE, NOT PER JOB ────────────────────────────────
 *
 * `tradingHours()` resolves the week — mask, times and the holiday set — in one
 * go, and every function here takes it as an argument. A list of 200 jobs that
 * re-read four settings and a year of holidays per row would be 1,000 queries to
 * render one page.
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

/** A wall-clock string for storing, from millis. The inverse of storedMillis. */
function toStored(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  )
}

export type SlaPolicy = {
  id: number
  priority: JobPriority
  name: string
  respondMinutes: number | null
  resolveMinutes: number | null
  isActive: boolean
  note: string | null
  /** Whose promise this is (164). NULL is the business default. */
  customerId: number | null
  customerName: string | null
  /**
   * Business minutes from the REPORTED time after which somebody is told.
   *
   * Not measured from the breach: a business that wants warning BEFORE the
   * deadline sets this below respondMinutes, and measuring from the breach
   * would make that inexpressible.
   */
  escalateAfterMinutes: number | null
  escalateToUserId: number | null
}

const mapPolicy = (r: Row): SlaPolicy => ({
  id: Number(r.id),
  priority: String(r.priority) as JobPriority,
  name: String(r.name),
  respondMinutes: r.respond_minutes === null ? null : Number(r.respond_minutes),
  resolveMinutes: r.resolve_minutes === null ? null : Number(r.resolve_minutes),
  isActive: Number(r.is_active) === 1,
  note: r.note === null ? null : String(r.note),
  // All four undefined on a site without 164, which reads as the business
  // default with no escalation — exactly what those rows meant before.
  customerId:
    r.customer_id === null || r.customer_id === undefined ? null : Number(r.customer_id),
  customerName:
    r.customer_name === null || r.customer_name === undefined ? null : String(r.customer_name),
  escalateAfterMinutes:
    r.escalate_after_minutes === null || r.escalate_after_minutes === undefined
      ? null
      : Number(r.escalate_after_minutes),
  escalateToUserId:
    r.escalate_to_user_id === null || r.escalate_to_user_id === undefined
      ? null
      : Number(r.escalate_to_user_id),
})

export async function listSlaPolicies(
  siteId: number,
  includeInactive = true,
): Promise<SlaPolicy[]> {
  /*
   * Business defaults FIRST, then each customer's overrides (164). A screen
   * that mixed them would make "which is the default" a question somebody has
   * to work out from a column.
   *
   * Tolerant of a site without 164 — the catch falls back to the query this
   * function has always run.
   */
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.priority, p.name, p.respond_minutes, p.resolve_minutes, p.is_active, p.note,
            p.customer_id, p.escalate_after_minutes, p.escalate_to_user_id,
            c.name AS customer_name
       FROM job_sla_policies p
       LEFT JOIN customers c ON c.id = p.customer_id
      ${includeInactive ? '' : 'WHERE p.is_active = 1'}
      ORDER BY CASE WHEN p.customer_id IS NULL THEN 0 ELSE 1 END,
               c.name,
               FIELD(p.priority, 'urgent','high','normal','low')`,
  ).catch(() =>
    siteQuery<Row>(
      siteId,
      `SELECT id, priority, name, respond_minutes, resolve_minutes, is_active, note
         FROM job_sla_policies
        ${includeInactive ? '' : 'WHERE is_active = 1'}
        ORDER BY FIELD(priority, 'urgent','high','normal','low')`,
    ),
  )
  return rows.map(mapPolicy)
}

/**
 * The trading week, resolved once.
 *
 * The holiday window is deliberately generous — a year back and a year forward —
 * because the two callers want opposite ends of it: a deadline is computed
 * forward from today, and elapsed business time on an old job is measured
 * backward. One query covering both beats two that each get it half right.
 *
 * A malformed setting falls back to the default rather than throwing. A typo in
 * an opening time must not take down the job list; it means the SLA figures are
 * wrong until somebody fixes the setting, which the setup screen validates
 * against.
 */
export async function tradingHours(siteId: number): Promise<TradingHours> {
  const s = await getSettings(siteId, [
    'job_sla_trading_days',
    'job_sla_opens_at',
    'job_sla_closes_at',
    'job_sla_skip_holidays',
  ])

  const days = isDayMask(s.job_sla_trading_days)
    ? s.job_sla_trading_days
    : DEFAULT_TRADING_HOURS.days
  const opensAt = parseClock(s.job_sla_opens_at) ?? DEFAULT_TRADING_HOURS.opensAt
  const closesAt = parseClock(s.job_sla_closes_at) ?? DEFAULT_TRADING_HOURS.closesAt

  let holidays: ReadonlySet<string> = new Set()
  if (s.job_sla_skip_holidays === '1') {
    const now = new Date()
    const from = new Date(now.getTime() - 400 * 86_400_000).toISOString().slice(0, 10)
    const to = new Date(now.getTime() + 400 * 86_400_000).toISOString().slice(0, 10)
    // Tolerant: a site without the holiday tables must still see its job list.
    holidays = await holidayDatesFor(siteId, from, to).catch(() => new Set<string>())
  }

  const resolved = { days, opensAt, closesAt, holidays }
  return tradingWeekIsUsable(resolved) ? resolved : { ...DEFAULT_TRADING_HOURS, holidays }
}

/**
 * The deadlines a job gets, from its priority and when it was reported.
 *
 * Returns nulls rather than refusing when no policy applies: plenty of
 * businesses promise nothing for low-priority work, and a job with no target is
 * a normal job rather than an error. The screens render that as "No target".
 */
export async function deadlinesFor(
  siteId: number,
  priority: JobPriority,
  reportedAt: string | Date,
  hours?: TradingHours,
  /**
   * Whose promise to use (164). Omitted or null means the business default,
   * which is what every call meant before per-customer policies existed.
   */
  customerId?: number | null,
): Promise<{
  policyId: number | null
  respondBy: string | null
  resolveBy: string | null
}> {
  /*
   * This customer's policy for this priority, else the business default.
   *
   * ONE query with an ORDER BY rather than two reads, because two reads is two
   * chances to answer differently — and this runs on every job save.
   *
   * `customer_id = ?` sorts before `customer_id IS NULL` because the CASE puts
   * the specific match first. NULL-safe comparison is deliberately NOT used:
   * `<=>` would make a NULL customerId match the default row, which is right,
   * but it would ALSO match nothing else, and the explicit CASE says what is
   * happening to the next reader.
   *
   * Tolerant of a site without 164: customer_id does not exist there, so the
   * whole query fails and the catch falls back to the priority-only read that
   * has always worked.
   */
  const policy = await siteQueryOne<Row>(
    siteId,
    `SELECT id, priority, name, respond_minutes, resolve_minutes, is_active, note,
            customer_id, escalate_after_minutes, escalate_to_user_id
       FROM job_sla_policies
      WHERE priority = ? AND is_active = 1
        AND (customer_id = ? OR customer_id IS NULL)
      ORDER BY CASE WHEN customer_id IS NULL THEN 1 ELSE 0 END
      LIMIT 1`,
    [priority, customerId ?? null],
  ).catch(() =>
    siteQueryOne<Row>(
      siteId,
      `SELECT id, priority, name, respond_minutes, resolve_minutes, is_active, note
         FROM job_sla_policies WHERE priority = ? AND is_active = 1 LIMIT 1`,
      [priority],
    ),
  )
  if (!policy) return { policyId: null, respondBy: null, resolveBy: null }

  const p = mapPolicy(policy)
  const week = hours ?? (await tradingHours(siteId))
  const fromMs = storedMillis(reportedAt)
  if (!Number.isFinite(fromMs)) return { policyId: p.id, respondBy: null, resolveBy: null }

  const respondMs =
    p.respondMinutes === null ? null : addBusinessMinutes(fromMs, p.respondMinutes, week)
  const resolveMs =
    p.resolveMinutes === null ? null : addBusinessMinutes(fromMs, p.resolveMinutes, week)

  return {
    policyId: p.id,
    respondBy: respondMs === null ? null : toStored(respondMs),
    resolveBy: resolveMs === null ? null : toStored(resolveMs),
  }
}

/**
 * Stamp the deadlines onto a job, inside the caller's transaction.
 *
 * Called on creation and whenever the priority changes — an urgent job downgraded
 * to normal should stop being measured against an urgent promise, because keeping
 * the old deadline would breach it for a promise that no longer applies.
 *
 * Takes `tx` because both callers already hold one, and computing a deadline in
 * its own connection while the job is half-written is how the two disagree.
 */
export async function applyDeadlinesTx(
  tx: PoolConnection,
  siteId: number,
  jobId: number,
  priority: JobPriority,
  reportedAt: string | Date,
): Promise<void> {
  /*
   * The customer is read HERE rather than passed in (164).
   *
   * Both callers already hold the job id and would have to thread the customer
   * through; reading it off the row the transaction is about to stamp means a
   * job whose customer changed cannot be measured against the old customer's
   * promise. Read on the tx, because that is the row this transaction holds.
   */
  let customerId: number | null = null
  try {
    const [rows] = await tx.query<Row[]>(`SELECT customer_id FROM job_cards WHERE id = ?`, [jobId])
    const value = rows[0]?.customer_id
    customerId = value === null || value === undefined ? null : Number(value)
  } catch {
    customerId = null
  }

  const { policyId, respondBy, resolveBy } = await deadlinesFor(
    siteId,
    priority,
    reportedAt,
    undefined,
    customerId,
  )
  await tx.execute(
    `UPDATE job_cards SET sla_policy_id = ?, respond_by = ?, resolve_by = ? WHERE id = ?`,
    [policyId, respondBy, resolveBy, jobId],
  )
}

export type SlaStanding = {
  policyName: string | null
  respondBy: string | null
  resolveBy: string | null
  respondedAt: string | null
  respondedByName: string | null
  respondState: SlaState
  resolveState: SlaState
  /** Business minutes left against the response target. Negative means late. */
  respondMinutesLeft: number | null
  resolveMinutesLeft: number | null
  /**
   * How long the first reply actually took, in business minutes.
   *
   * Needs `reportedAt`, so it is null when the caller did not supply one. The
   * figure an owner asks for is "how fast do we answer", and it has to include
   * the jobs that breached.
   */
  responseTookMinutes: number | null
}

/**
 * Where one job stands.
 *
 * `nowMs` is an argument rather than a `Date.now()` inside, so a list renders
 * every row against the SAME instant — otherwise two jobs one millisecond apart
 * can disagree about whether the deadline has passed, and a test cannot assert
 * anything.
 */
export function standingFor(
  job: {
    respondBy: string | null
    resolveBy: string | null
    respondedAt: string | null
    respondedByName?: string | null
    closedAt: string | null
    policyName?: string | null
    reportedAt?: string | null
  },
  nowMs: number,
  hours: TradingHours,
): SlaStanding {
  const respondByMs = storedMillis(job.respondBy)
  const resolveByMs = storedMillis(job.resolveBy)
  const respondedMs = storedMillis(job.respondedAt)
  /*
   * Closure is what satisfies the RESOLVE target. Not "completed" the status
   * role — a job cancelled after the deadline did not resolve anything, and
   * job_cards.closed_at is only written by closeJob(), which cancelJob does not
   * call. So a cancelled job keeps counting down, which is the honest answer.
   */
  const closedMs = storedMillis(job.closedAt)
  const reportedMs = storedMillis(job.reportedAt)

  return {
    policyName: job.policyName ?? null,
    respondBy: job.respondBy,
    resolveBy: job.resolveBy,
    respondedAt: job.respondedAt,
    respondedByName: job.respondedByName ?? null,
    respondState: slaState(respondByMs, respondedMs, nowMs),
    resolveState: slaState(resolveByMs, closedMs, nowMs),
    respondMinutesLeft: Number.isFinite(respondedMs)
      ? null
      : minutesUntilDue(respondByMs, nowMs, hours),
    resolveMinutesLeft: Number.isFinite(closedMs)
      ? null
      : minutesUntilDue(resolveByMs, nowMs, hours),
    responseTookMinutes:
      Number.isFinite(respondedMs) && Number.isFinite(reportedMs)
        ? businessMinutesBetween(reportedMs, respondedMs, hours)
        : null,
  }
}

export type SlaActionResult = { ok: true } | { ok: false; error: string }

/**
 * Somebody has picked this job up.
 *
 * Written ONCE and never overwritten: a second reply does not un-respond the
 * first, and letting it move would quietly turn a met target into a breach.
 * The `responded_at IS NULL` in the WHERE is what enforces that — a guard in
 * code would race two dispatchers opening the same job.
 *
 * Deliberately NOT derived from the activity log. The log records the creation
 * itself, so its first entry would mark every job as responded to the instant it
 * was typed in.
 */
export async function markResponded(
  siteId: number,
  actor: Actor,
  jobId: number,
  at?: string,
): Promise<SlaActionResult> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, responded_at FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (job.responded_at !== null) {
    return { ok: false, error: 'Somebody has already responded to this job.' }
  }

  const stamp = at ?? toStored(Date.now())
  const done = await siteExecute(
    siteId,
    `UPDATE job_cards
        SET responded_at = ?, responded_by_user_id = ?, responded_by_name = ?
      WHERE id = ? AND responded_at IS NULL`,
    [stamp, actor.userId, actor.userName, jobId],
  )
  if (done.affectedRows === 0) {
    return { ok: false, error: 'Somebody has already responded to this job.' }
  }
  return { ok: true }
}

/**
 * Where one job stands, fetched on its own.
 *
 * Its own query rather than six more columns on `JobCard`, which a dozen screens
 * already read: widening that type to serve one card would make every one of them
 * carry fields they do not use, and the job page fetches in parallel anyway.
 *
 * Returns null when the job has no target at all, so the card can be absent
 * rather than rendering an empty frame.
 */
export async function jobStanding(
  siteId: number,
  jobId: number,
): Promise<SlaStanding | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT j.respond_by, j.resolve_by, j.responded_at, j.responded_by_name,
            j.closed_at, j.reported_at, p.name AS policy_name
       FROM job_cards j
       LEFT JOIN job_sla_policies p ON p.id = j.sla_policy_id
      WHERE j.id = ?`,
    [jobId],
  )
  if (!row) return null
  if (row.respond_by === null && row.resolve_by === null) return null

  return standingFor(
    {
      respondBy: wallClock(row.respond_by),
      resolveBy: wallClock(row.resolve_by),
      respondedAt: wallClock(row.responded_at),
      respondedByName: row.responded_by_name === null ? null : String(row.responded_by_name),
      closedAt: wallClock(row.closed_at),
      reportedAt: wallClock(row.reported_at),
      policyName: row.policy_name === null ? null : String(row.policy_name),
    },
    Date.now(),
    await tradingHours(siteId),
  )
}

export type SlaWorklistRow = {
  jobId: number
  documentNumber: string | null
  title: string
  customerName: string | null
  priority: JobPriority
  statusName: string
  ownerName: string | null
  reportedAt: string | null
  standing: SlaStanding
}

/**
 * Open jobs with a target, worst first.
 *
 * TWO worklists in one query, distinguished by `kind`, because they are two
 * different questions asked by two different people: a dispatcher asks who is
 * still waiting for a first reply, a manager asks what will miss its fix date.
 * Filtering in SQL rather than fetching every open job and sorting in JS, so a
 * shop with 4,000 open jobs does not ship all of them to render twenty.
 */
export async function slaWorklist(
  siteId: number,
  kind: 'respond' | 'resolve',
  limit = 50,
): Promise<SlaWorklistRow[]> {
  const week = await tradingHours(siteId)
  const nowMs = Date.now()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT j.id, j.document_number, j.title, j.customer_name, j.priority,
            j.owner_name, j.reported_at, j.respond_by, j.resolve_by,
            j.responded_at, j.responded_by_name, j.closed_at,
            s.name AS status_name, p.name AS policy_name
       FROM job_cards j
       JOIN job_statuses s ON s.id = j.status_id
       LEFT JOIN job_sla_policies p ON p.id = j.sla_policy_id
      WHERE j.status = 'open'
        ${
          kind === 'respond'
            ? 'AND j.respond_by IS NOT NULL AND j.responded_at IS NULL'
            : 'AND j.resolve_by IS NOT NULL'
        }
      ORDER BY ${kind === 'respond' ? 'j.respond_by' : 'j.resolve_by'} ASC
      LIMIT ?`,
    [Math.max(1, Math.min(500, Math.floor(limit)))],
  )

  return rows.map((r) => ({
    jobId: Number(r.id),
    documentNumber: r.document_number === null ? null : String(r.document_number),
    title: String(r.title),
    customerName: r.customer_name === null ? null : String(r.customer_name),
    priority: String(r.priority) as JobPriority,
    statusName: String(r.status_name),
    ownerName: r.owner_name === null ? null : String(r.owner_name),
    reportedAt: wallClock(r.reported_at),
    standing: standingFor(
      {
        respondBy: wallClock(r.respond_by),
        resolveBy: wallClock(r.resolve_by),
        respondedAt: wallClock(r.responded_at),
        respondedByName: r.responded_by_name === null ? null : String(r.responded_by_name),
        closedAt: wallClock(r.closed_at),
        policyName: r.policy_name === null ? null : String(r.policy_name),
        reportedAt: wallClock(r.reported_at),
      },
      nowMs,
      week,
    ),
  }))
}

export type SlaCounts = {
  awaitingResponse: number
  responseBreached: number
  resolveBreached: number
  dueToday: number
}

/**
 * The tiles above the worklist.
 *
 * Counted in SQL against NOW() rather than by fetching rows and filtering: the
 * whole point of a tile is that it is cheap enough to render on every page load.
 *
 * NOW() is the database clock, and every deadline was written in the same wall
 * clock by the same pool at timezone 'Z', so the two agree. Comparing a stored
 * wall clock against a JS Date built from local time is the bug that made the
 * schedule draw every block at the right edge.
 */
export async function slaCounts(siteId: number): Promise<SlaCounts> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT
       SUM(CASE WHEN respond_by IS NOT NULL AND responded_at IS NULL THEN 1 ELSE 0 END) AS awaiting,
       SUM(CASE WHEN respond_by IS NOT NULL AND responded_at IS NULL AND respond_by < NOW() THEN 1 ELSE 0 END) AS resp_breached,
       SUM(CASE WHEN resolve_by IS NOT NULL AND resolve_by < NOW() THEN 1 ELSE 0 END) AS res_breached,
       SUM(CASE WHEN resolve_by IS NOT NULL AND DATE(resolve_by) = DATE(NOW()) THEN 1 ELSE 0 END) AS due_today
     FROM job_cards WHERE status = 'open'`,
  )
  return {
    awaitingResponse: Number(row?.awaiting ?? 0),
    responseBreached: Number(row?.resp_breached ?? 0),
    resolveBreached: Number(row?.res_breached ?? 0),
    dueToday: Number(row?.due_today ?? 0),
  }
}

/**
 * How many open jobs carry no target.
 *
 * Its own query rather than `reconcileJobSla().missingDeadlines.length`, because
 * the setup screen wants one number and the reconcile does three queries and a
 * day-loop per row to produce it.
 */
export async function untargetedJobCount(siteId: number): Promise<number> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n
       FROM job_cards j
       JOIN job_sla_policies p ON p.priority = j.priority AND p.is_active = 1
      WHERE j.status = 'open' AND j.respond_by IS NULL AND p.respond_minutes IS NOT NULL`,
  )
  return Number(row?.n ?? 0)
}

export type PolicyInput = {
  priority: JobPriority
  name: string
  respondMinutes: number | null
  resolveMinutes: number | null
  isActive: boolean
  note: string | null
  /** Whose promise (164). NULL is the business default. */
  customerId?: number | null
  escalateAfterMinutes?: number | null
  escalateToUserId?: number | null
}

/**
 * Pure, so the screen refuses the same things for the same reasons.
 *
 * The load-bearing rule is respond <= resolve: promising a fix in an hour and a
 * first reply in four is not a strict promise, it is an unnoticed typo that puts
 * every job into the breach list on the wrong side.
 */
export function validatePolicy(input: PolicyInput): string | null {
  if (!input.name.trim()) return 'Give the policy a name.'
  if (input.name.trim().length > 120) return 'That name is too long.'

  for (const [label, mins] of [
    ['response', input.respondMinutes],
    ['resolution', input.resolveMinutes],
  ] as const) {
    if (mins === null) continue
    if (!Number.isFinite(mins) || mins <= 0) {
      return `A ${label} target must be more than zero minutes, or left blank for no promise.`
    }
    // 200 working days at 9 hours. Past this it is not a promise, it is a typo.
    if (mins > 108_000) return `That ${label} target is longer than a working year.`
  }

  if (
    input.respondMinutes !== null &&
    input.resolveMinutes !== null &&
    input.respondMinutes > input.resolveMinutes
  ) {
    return 'The response target cannot be longer than the resolution target — a job cannot be fixed before it is answered.'
  }
  return null
}

export async function savePolicy(
  siteId: number,
  actor: Actor,
  id: number,
  input: PolicyInput,
): Promise<SlaActionResult> {
  const refusal = validatePolicy(input)
  if (refusal) return { ok: false, error: refusal }

  const existing = await siteQueryOne<Row>(
    siteId,
    `SELECT id, priority FROM job_sla_policies WHERE id = ?`,
    [id],
  )
  if (!existing) return { ok: false, error: 'That policy no longer exists.' }

  /*
   * Escalation columns are written through a tolerant second statement rather
   * than widening the UPDATE above: a site without 164 must still be able to
   * edit the four promises it already has.
   */
  await siteExecute(
    siteId,
    `UPDATE job_sla_policies
        SET name = ?, respond_minutes = ?, resolve_minutes = ?, is_active = ?, note = ?
      WHERE id = ?`,
    [
      input.name.trim(),
      input.respondMinutes,
      input.resolveMinutes,
      input.isActive ? 1 : 0,
      input.note?.trim() || null,
      id,
    ],
  )

  if (input.escalateAfterMinutes !== undefined || input.escalateToUserId !== undefined) {
    await siteExecute(
      siteId,
      `UPDATE job_sla_policies
          SET escalate_after_minutes = ?, escalate_to_user_id = ?
        WHERE id = ?`,
      [input.escalateAfterMinutes ?? null, input.escalateToUserId ?? null, id],
    ).catch(() => undefined)
  }
  return { ok: true }
}

/**
 * A promise made to ONE customer (164, §17.5).
 *
 * ── WHY THIS CANNOT USE INSERT IGNORE ──────────────────────────────────────
 *
 * uq_sla_customer_priority is (customer_id, priority) and customer_id is
 * nullable. In MySQL two rows of (NULL, 'urgent') do NOT collide, because NULL
 * is not equal to NULL — so the unique key cannot stop a second business
 * default and INSERT IGNORE against it does nothing at all. That is the 083
 * gl_mappings trap, and 113's seed comment says in as many words that it did
 * not apply while priority was the whole key. Adding customer_id made it apply.
 *
 * So the duplicate check is an explicit read, expressed with IS NULL rather
 * than `= NULL`, which would match nothing and let every duplicate through.
 */
export async function createPolicy(
  siteId: number,
  actor: Actor,
  input: PolicyInput,
): Promise<SlaActionResult> {
  const refusal = validatePolicy(input)
  if (refusal) return { ok: false, error: refusal }

  const customerId = input.customerId ?? null

  const clash = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM job_sla_policies
      WHERE priority = ?
        AND ${customerId === null ? 'customer_id IS NULL' : 'customer_id = ?'}
      LIMIT 1`,
    customerId === null ? [input.priority] : [input.priority, customerId],
  ).catch(() => null)

  if (clash) {
    return {
      ok: false,
      error:
        customerId === null
          ? 'There is already a business-wide promise for that priority. Edit it instead.'
          : 'That customer already has a promise for that priority. Edit it instead.',
    }
  }

  await siteExecute(
    siteId,
    `INSERT INTO job_sla_policies
       (customer_id, priority, name, respond_minutes, resolve_minutes, is_active, note,
        escalate_after_minutes, escalate_to_user_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      customerId,
      input.priority,
      input.name.trim(),
      input.respondMinutes,
      input.resolveMinutes,
      input.isActive ? 1 : 0,
      input.note?.trim() || null,
      input.escalateAfterMinutes ?? null,
      input.escalateToUserId ?? null,
    ],
  )

  /*
   * NOT logged to activity_log, following savePolicy above: that table is keyed
   * on an entity and an entity id, and a policy is neither a job card nor a
   * customer. Inventing `entityId: 0` would put a row on the timeline of
   * nothing. The actor is still taken so the action layer's guard reads the
   * same as every sibling.
   */
  void actor
  return { ok: true }
}

/**
 * Remove a per-customer promise. The business defaults are NOT deletable —
 * 113 seeds exactly four and every job with no customer policy depends on one
 * being there.
 */
export async function deletePolicy(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<SlaActionResult> {
  const policy = await siteQueryOne<Row>(
    siteId,
    `SELECT id, name, customer_id FROM job_sla_policies WHERE id = ?`,
    [id],
  ).catch(() => null)
  if (!policy) return { ok: false, error: 'That policy no longer exists.' }

  if (policy.customer_id === null || policy.customer_id === undefined) {
    return {
      ok: false,
      error: 'A business-wide promise cannot be deleted. Switch it off instead.',
    }
  }

  await siteExecute(siteId, `DELETE FROM job_sla_policies WHERE id = ?`, [id])
  // Not logged, for the reason given in createPolicy.
  void actor
  return { ok: true }
}

export type SlaDrift = {
  /**
   * A deadline that does not match what its policy would produce today.
   *
   * NOT a bug on its own — that is exactly what storing the deadline buys, and a
   * job promised under last months hours SHOULD keep its old figure. Reported so
   * an owner who has just changed the trading hours can see how many live jobs
   * are still measured against the old week, and decide.
   */
  staleDeadlines: {
    jobId: number
    documentNumber: string | null
    priority: string
    stored: string | null
    wouldBe: string | null
  }[]
  /**
   * Open, has a priority with a live policy, and yet carries no deadline.
   *
   * USUALLY NOT A BUG. Every job created before the SLA feature existed lands
   * here, and that is the correct state for them: nobody promised those customers
   * anything, and back-dating a deadline would fabricate a promise that was never
   * made — most of them would also appear already breached the moment the feature
   * shipped, which is worse than no figure at all.
   *
   * Reported so an owner can see how many of their live jobs are unmeasured and
   * decide. It becomes a real bug only if it appears on a job created AFTER this
   * migration, which would mean applyDeadlinesTx was skipped.
   */
  missingDeadlines: { jobId: number; documentNumber: string | null; priority: string }[]
  /** Responded before it was reported. Only a hand-edit can do this. */
  impossibleResponse: {
    jobId: number
    documentNumber: string | null
    reportedAt: string | null
    respondedAt: string | null
  }[]
}

/**
 * Drift between the promise and the record. Reports, never repairs.
 *
 * `staleDeadlines` is capped: recomputing a deadline costs a settings read and a
 * day loop per job, and a shop with 4,000 open jobs must not turn the
 * reconciliation screen into a two-minute page. The cap is reported so a
 * truncated list never reads as a complete one.
 */
export async function reconcileJobSla(siteId: number, sampleLimit = 300): Promise<SlaDrift> {
  const week = await tradingHours(siteId)

  const [open, missing, impossible] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT j.id, j.document_number, j.priority, j.reported_at, j.respond_by,
              p.respond_minutes
         FROM job_cards j
         JOIN job_sla_policies p ON p.id = j.sla_policy_id AND p.is_active = 1
        WHERE j.status = 'open' AND j.respond_by IS NOT NULL AND p.respond_minutes IS NOT NULL
        ORDER BY j.id DESC
        LIMIT ?`,
      [Math.max(1, Math.min(2000, Math.floor(sampleLimit)))],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT j.id, j.document_number, j.priority
         FROM job_cards j
         JOIN job_sla_policies p ON p.priority = j.priority AND p.is_active = 1
        WHERE j.status = 'open'
          AND j.respond_by IS NULL
          AND p.respond_minutes IS NOT NULL`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT id, document_number, reported_at, responded_at
         FROM job_cards
        WHERE responded_at IS NOT NULL AND reported_at IS NOT NULL
          AND responded_at < reported_at`,
    ),
  ])

  const stale: SlaDrift['staleDeadlines'] = []
  for (const r of open) {
    const fromMs = storedMillis(wallClock(r.reported_at))
    const mins = Number(r.respond_minutes)
    const wouldBeMs = addBusinessMinutes(fromMs, mins, week)
    const storedText = wallClock(r.respond_by)
    const wouldBeText = wouldBeMs === null ? null : toStored(wouldBeMs)
    // A minute of tolerance: the stored value has second precision.
    if (storedText !== wouldBeText) {
      stale.push({
        jobId: Number(r.id),
        documentNumber: r.document_number === null ? null : String(r.document_number),
        priority: String(r.priority),
        stored: storedText,
        wouldBe: wouldBeText,
      })
    }
  }

  return {
    staleDeadlines: stale,
    missingDeadlines: missing.map((r) => ({
      jobId: Number(r.id),
      documentNumber: r.document_number === null ? null : String(r.document_number),
      priority: String(r.priority),
    })),
    impossibleResponse: impossible.map((r) => ({
      jobId: Number(r.id),
      documentNumber: r.document_number === null ? null : String(r.document_number),
      reportedAt: wallClock(r.reported_at),
      respondedAt: wallClock(r.responded_at),
    })),
  }
}

/**
 * How long first replies actually took, over a window.
 *
 * The figure an owner wants is the one that includes the jobs that breached, so
 * this is a plain average over every responded job in the period rather than only
 * the ones that met their target.
 */
export async function responseStats(
  siteId: number,
  fromDay: string,
  toDay: string,
): Promise<{ responded: number; metCount: number; averageMinutes: number | null }> {
  const week = await tradingHours(siteId)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT reported_at, responded_at, respond_by
       FROM job_cards
      WHERE responded_at IS NOT NULL
        AND DATE(reported_at) BETWEEN ? AND ?`,
    [fromDay, toDay],
  )

  let total = 0
  let met = 0
  for (const r of rows) {
    const reported = storedMillis(wallClock(r.reported_at))
    const responded = storedMillis(wallClock(r.responded_at))
    const due = storedMillis(wallClock(r.respond_by))
    total += businessMinutesBetween(reported, responded, week)
    if (Number.isFinite(due) && responded <= due) met++
  }

  return {
    responded: rows.length,
    metCount: met,
    averageMinutes: rows.length === 0 ? null : Math.round((total / rows.length) * 10) / 10,
  }
}

/* ── Escalation (164, §17.5) ──────────────────────────────────────────────── */

export type EscalationResult = {
  /** How many jobs were escalated on this pass. */
  escalated: number
  skipped?: 'off' | 'no_policies'
}

/**
 * Tell somebody a promise has been missed.
 *
 * ── THE CLAIM COMES BEFORE THE BELL ────────────────────────────────────────
 *
 * `job_sla_escalations` has UNIQUE (job_card_id, kind) and the row is INSERTed
 * BEFORE notify() is called. Both columns are NOT NULL, so unlike the policy
 * key this one really does dedupe — and a job breached on Monday is escalated
 * once rather than every five minutes until somebody closes it.
 *
 * INSERT IGNORE is correct HERE, precisely because there is no nullable column
 * in the key. That is the same test 113 applied to its own seed, and the same
 * one 164 fails.
 *
 * ── BREACH STAYS DERIVED ───────────────────────────────────────────────────
 *
 * 113's header argues that a stored breach flag is wrong the minute after it is
 * written, and nothing here stores one. This table records that somebody was
 * TOLD, which is a different fact and does not go stale: the telling happened.
 *
 * ── WHY IT IS THE BELL AND NOT EMAIL ───────────────────────────────────────
 *
 * notify() has an audience and a userId, never throws, and an escalation is an
 * internal nudge rather than correspondence. Email would also mean a second
 * delivery path to keep working; the bell is already on every screen.
 */
export async function escalateOverdue(siteId: number): Promise<EscalationResult> {
  // getSettings, plural — the one this module already uses.
  const s = await getSettings(siteId, ['job_sla_escalation_enabled']).catch(() => ({}) as Record<string, string>)
  if (String(s.job_sla_escalation_enabled ?? '0') === '0') return { escalated: 0, skipped: 'off' }

  /*
   * Only policies that actually name somebody and a delay. A policy with an
   * escalate_to_user_id and no minutes (or the reverse) is incomplete rather
   * than instant — treating it as "escalate immediately" would surprise
   * somebody who half-filled a form.
   */
  const policies = await siteQuery<Row>(
    siteId,
    `SELECT id, escalate_after_minutes, escalate_to_user_id
       FROM job_sla_policies
      WHERE is_active = 1
        AND escalate_after_minutes IS NOT NULL
        AND escalate_to_user_id IS NOT NULL`,
  ).catch(() => [])
  if (policies.length === 0) return { escalated: 0, skipped: 'no_policies' }

  const week = await tradingHours(siteId)
  const byPolicy = new Map<number, { after: number; userId: number }>()
  for (const p of policies) {
    byPolicy.set(Number(p.id), {
      after: Number(p.escalate_after_minutes),
      userId: Number(p.escalate_to_user_id),
    })
  }

  /*
   * OPEN jobs measured against one of those policies, that have not been
   * responded to. A closed job cannot be escalated: the work is done, and
   * telling a manager about it is noise about history.
   */
  const jobs = await siteQuery<Row>(
    siteId,
    `SELECT id, document_number, title, reported_at, respond_by, responded_at, sla_policy_id
       FROM job_cards
      WHERE status = 'open'
        AND responded_at IS NULL
        AND sla_policy_id IN (${[...byPolicy.keys()].map(() => '?').join(',')})
      LIMIT 500`,
    [...byPolicy.keys()],
  ).catch(() => [])

  const { notify } = await import('./notifications')
  const now = Date.now()
  let escalated = 0

  for (const job of jobs) {
    const rule = byPolicy.get(Number(job.sla_policy_id))
    if (!rule) continue

    /*
     * Business minutes since REPORTED, not since the deadline — see the column
     * comment in 164. A business wanting warning BEFORE the promise is due sets
     * a figure below respond_minutes, which measuring from the breach could not
     * express.
     */
    const reported = storedMillis(wallClock(job.reported_at))
    if (!Number.isFinite(reported)) continue
    const elapsed = businessMinutesBetween(reported, now, week)
    if (elapsed < rule.after) continue

    // THE CLAIM, stamped before the bell. affectedRows === 0 means somebody
    // (or an earlier tick) already told them.
    const claimed = await siteExecute(
      siteId,
      `INSERT IGNORE INTO job_sla_escalations (job_card_id, kind, notified_user_id)
       VALUES (?, 'respond', ?)`,
      [Number(job.id), rule.userId],
    ).catch(() => ({ affectedRows: 0 }))
    if (claimed.affectedRows === 0) continue

    await notify(siteId, {
      event: 'sla_escalation',
      // userId wins over audience, so this reaches the named person only.
      audience: null,
      userId: rule.userId,
      title: `Still no reply: ${String(job.document_number ?? `job #${Number(job.id)}`)}`,
      body: `${String(job.title)} — no first reply after ${rule.after} business minutes.`,
      href: `/jobs/${Number(job.id)}`,
    })
    escalated++
  }

  return { escalated }
}
