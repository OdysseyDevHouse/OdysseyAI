import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { today } from './ledger'
import { nextOccurrence, FREQUENCY_LABELS, type RecurringFrequency } from '../expenseModel'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { nextDocumentNumber } from './sequences'
import { statusForRole } from './jobStatuses'
import { applyHeadlines } from './jobHeadlines'
import { applyDeadlinesTx } from './jobSla'
import type { JobPriority } from '../jobStatusModel'

/**
 * Recurring jobs: a quarterly service, an annual certificate.
 *
 * ── THIS IS contracts.ts WITH A JOB INSTEAD OF AN INVOICE ──────────────────
 *
 * The shape is copied deliberately, because that module already solved the two
 * hard parts of recurrence:
 *
 *   CLAIM-THEN-CREATE. A period is inserted into `job_series_runs` under a unique
 *   key on (series_id, for_date) BEFORE the job is built. A second tick racing
 *   the first fails on that insert having written nothing, which is what makes the
 *   endpoint safe to call twice a minute.
 *
 *   CATCH-UP. `duePeriods()` walks from the last generated period to today and
 *   returns every one it passed. A series left un-ticked for three months raises
 *   three jobs, one per period — not one, and not seventy-three.
 *
 * What is genuinely shared is `nextOccurrence()` from expenseModel: pure date
 * arithmetic, already used by expenses and contracts, and the place where "the
 * 31st in February" is decided once.
 *
 * ── WHAT AN OCCURRENCE DOES NOT INHERIT ────────────────────────────────────
 *
 * Section 19 of the PRD is explicit, and this is why `generateDueJobs` BUILDS a
 * job rather than cloning the previous one: no checklist answers, no time entries,
 * no costs, no comments, no files. Cloning a row would carry all of it, and a
 * service sheet arriving pre-signed by last quarter's technician is worse than no
 * service sheet.
 *
 * The template it DOES carry: customer, site, asset, title, priority, owner, and
 * the kinds of work — which then attach their own fresh checks through
 * applyHeadlines.
 */

type Row = RowDataPacket & Record<string, unknown>

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/** A DATE column as YYYY-MM-DD. Never String(driverDate) — that is a locale. */
const dateOnly = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  }
  const raw = String(value)
  return raw.length >= 10 ? raw.slice(0, 10) : raw
}

/**
 * Every period a series owes, from its cursor up to `asAt`.
 *
 * The job-side twin of contractModel's duePeriods, over the same shared
 * `nextOccurrence`. Not a call into the contracts version because that one is
 * typed to a ContractSchedule carrying escalation terms this has no use for.
 *
 * `leadDays` shifts the WINDOW, not the date: a series with 14 days of lead time
 * raises the job for the 30th on the 16th, and the job still says the 30th.
 * Shifting the date instead would quietly move every due date forward.
 *
 * Capped, and the cap is REPORTED by the caller rather than silently applied —
 * past two years of missed periods, something is wrong that generating them all
 * would make worse.
 */
export function duePeriods(
  schedule: {
    frequency: RecurringFrequency
    dayOfMonth: number
    dayOfWeek: number | null
    startsOn: string
    endsOn: string | null
    lastGeneratedFor: string | null
  },
  asAt: string,
  leadDays = 0,
  cap = 24,
): { periods: string[]; capped: boolean } {
  const horizon = leadDays > 0 ? addDays(asAt, leadDays) : asAt
  const periods: string[] = []
  let cursor = schedule.lastGeneratedFor

  for (let guard = 0; guard <= cap; guard++) {
    const next = nextOccurrence(
      {
        frequency: schedule.frequency,
        dayOfMonth: schedule.dayOfMonth,
        dayOfWeek: schedule.dayOfWeek,
        startsOn: schedule.startsOn,
        endsOn: schedule.endsOn,
        lastGeneratedFor: cursor,
      },
      horizon,
    )
    if (!next || next > horizon) break
    // One past the cap tells the caller it was truncated rather than complete.
    if (periods.length === cap) return { periods, capped: true }
    periods.push(next)
    cursor = next
  }
  return { periods, capped: false }
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/* ── Reading ───────────────────────────────────────────────────────────────── */

export type JobSeries = {
  id: number
  name: string
  customerId: number
  customerName: string | null
  serviceAddressId: number | null
  serviceAddressName: string | null
  assetId: number | null
  assetDescription: string | null
  title: string
  description: string | null
  priority: JobPriority
  ownerUserId: number | null
  ownerName: string | null
  locationId: number | null
  frequency: RecurringFrequency
  frequencyLabel: string
  dayOfMonth: number
  dayOfWeek: number | null
  startsOn: string
  endsOn: string | null
  lastGeneratedFor: string | null
  leadDays: number
  isActive: boolean
  autoCreate: boolean
  note: string | null
  /** The next period this owes, or null when it is finished or switched off. */
  nextDueOn: string | null
  /** How many jobs it has raised. What makes deleting it a decision. */
  jobCount: number
  headlineIds: number[]
}

const SELECT_SERIES = `
  SELECT s.id, s.name, s.customer_id, s.service_address_id, s.asset_id, s.title,
         s.description, s.priority, s.owner_user_id, s.owner_name, s.location_id,
         s.frequency, s.day_of_month, s.day_of_week, s.starts_on, s.ends_on,
         s.last_generated_for, s.lead_days, s.is_active, s.auto_create, s.note,
         c.name AS customer_name, sa.name AS address_name, a.description AS asset_description,
         (SELECT COUNT(*) FROM job_cards j WHERE j.series_id = s.id) AS job_count
    FROM job_series s
    LEFT JOIN customers c          ON c.id = s.customer_id
    LEFT JOIN service_addresses sa ON sa.id = s.service_address_id
    LEFT JOIN customer_assets a    ON a.id = s.asset_id`

function mapSeries(r: Row, headlineIds: number[]): JobSeries {
  const frequency = String(r.frequency) as RecurringFrequency
  const startsOn = dateOnly(r.starts_on) ?? today()
  const endsOn = dateOnly(r.ends_on)
  const lastGeneratedFor = dateOnly(r.last_generated_for)

  return {
    id: Number(r.id),
    name: String(r.name),
    customerId: Number(r.customer_id),
    customerName: text(r.customer_name),
    serviceAddressId: r.service_address_id === null ? null : Number(r.service_address_id),
    serviceAddressName: text(r.address_name),
    assetId: r.asset_id === null ? null : Number(r.asset_id),
    assetDescription: text(r.asset_description),
    title: String(r.title),
    description: text(r.description),
    priority: String(r.priority) as JobPriority,
    ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
    ownerName: text(r.owner_name),
    locationId: r.location_id === null ? null : Number(r.location_id),
    frequency,
    frequencyLabel: FREQUENCY_LABELS[frequency],
    dayOfMonth: Number(r.day_of_month),
    dayOfWeek: r.day_of_week === null ? null : Number(r.day_of_week),
    startsOn,
    endsOn,
    lastGeneratedFor,
    leadDays: Number(r.lead_days),
    isActive: Number(r.is_active) === 1,
    autoCreate: Number(r.auto_create) === 1,
    note: text(r.note),
    /*
     * Computed rather than stored: a stored next-due would be wrong the moment
     * somebody edited the frequency, and would need a trigger to stay true. The
     * same argument isClosed() makes about open/closed.
     *
     * Looks a year ahead deliberately — the point is to show the date, not to
     * decide whether it is due, and an annual series with no lead time would
     * otherwise read "nothing scheduled" for eleven months.
     */
    nextDueOn:
      Number(r.is_active) === 1
        ? nextOccurrence(
            {
              frequency,
              dayOfMonth: Number(r.day_of_month),
              dayOfWeek: r.day_of_week === null ? null : Number(r.day_of_week),
              startsOn,
              endsOn,
              lastGeneratedFor,
            },
            addDays(today(), 400),
          )
        : null,
    jobCount: Number(r.job_count ?? 0),
    headlineIds,
  }
}

export async function listJobSeries(
  siteId: number,
  opts: { customerId?: number; assetId?: number; includeInactive?: boolean } = {},
): Promise<JobSeries[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (!opts.includeInactive) where.push('s.is_active = 1')
  if (opts.customerId) {
    where.push('s.customer_id = ?')
    params.push(opts.customerId)
  }
  if (opts.assetId) {
    where.push('s.asset_id = ?')
    params.push(opts.assetId)
  }

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_SERIES}
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.name, s.id DESC`,
    params,
  )
  if (rows.length === 0) return []

  // One query for every series' headlines rather than one per row.
  const ids = rows.map((r) => Number(r.id))
  const links = await siteQuery<Row>(
    siteId,
    `SELECT series_id, headline_id FROM job_series_headlines
      WHERE series_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order`,
    ids,
  )

  return rows.map((r) =>
    mapSeries(
      r,
      links.filter((l) => Number(l.series_id) === Number(r.id)).map((l) => Number(l.headline_id)),
    ),
  )
}

export async function getJobSeries(siteId: number, id: number): Promise<JobSeries | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_SERIES} WHERE s.id = ?`, [id])
  if (!row) return null
  const links = await siteQuery<Row>(
    siteId,
    `SELECT headline_id FROM job_series_headlines WHERE series_id = ? ORDER BY sort_order`,
    [id],
  )
  return mapSeries(row, links.map((l) => Number(l.headline_id)))
}

/* ── Writing ───────────────────────────────────────────────────────────────── */

export type SeriesInput = {
  id: number | null
  name: string
  customerId: number | null
  serviceAddressId: number | null
  assetId: number | null
  title: string
  description: string | null
  priority: JobPriority
  ownerUserId: number | null
  ownerName: string | null
  locationId: number | null
  frequency: RecurringFrequency
  dayOfMonth: number
  dayOfWeek: number | null
  startsOn: string
  endsOn: string | null
  leadDays: number
  isActive: boolean
  autoCreate: boolean
  note: string | null
  headlineIds: number[]
}

export type SeriesResult = { ok: true; id: number } | { ok: false; error: string }
export type SeriesActionResult = { ok: true } | { ok: false; error: string }

/** Pure, so the screen refuses the same things for the same reasons. */
export function validateSeries(input: SeriesInput): string | null {
  if (!input.name.trim()) return 'Give the schedule a name.'
  if (input.name.trim().length > 120) return 'That name is too long.'
  if (!input.title.trim()) return 'Say what the job will be called.'
  if (input.title.trim().length > 190) return 'That job title is too long.'

  /*
   * A schedule with nobody to serve raises work for nobody. Unlike a job card,
   * which allows a walk-in — a walk-in is by definition not recurring.
   */
  if (input.customerId === null) return 'Choose the customer this recurs for.'

  const bad = (v: string | null) =>
    v !== null && v !== '' && Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())
  if (!input.startsOn || bad(input.startsOn)) return 'That start date is not a real date.'
  if (bad(input.endsOn)) return 'That end date is not a real date.'
  if (input.endsOn && input.endsOn < input.startsOn) {
    return 'The end date is before the start date.'
  }

  if (input.dayOfMonth < 1 || input.dayOfMonth > 31) {
    return 'The day of the month has to be between 1 and 31.'
  }
  if (input.frequency === 'weekly') {
    if (input.dayOfWeek === null || input.dayOfWeek < 1 || input.dayOfWeek > 7) {
      return 'Choose which day of the week it falls on.'
    }
  }
  // 90 days. Past a quarter of lead time the job would be raised before the
  // previous occurrence had been done.
  if (!Number.isFinite(input.leadDays) || input.leadDays < 0 || input.leadDays > 90) {
    return 'Lead time has to be between 0 and 90 days.'
  }
  return null
}

export async function saveJobSeries(
  siteId: number,
  actor: Actor,
  input: SeriesInput,
): Promise<SeriesResult> {
  const refusal = validateSeries(input)
  if (refusal) return { ok: false, error: refusal }

  return siteTransaction(siteId, async (tx) => {
    let id = input.id ?? 0

    if (id === 0) {
      const [result] = await tx.execute(
        `INSERT INTO job_series
           (name, customer_id, service_address_id, asset_id, title, description, priority,
            owner_user_id, owner_name, location_id, frequency, day_of_month, day_of_week,
            starts_on, ends_on, lead_days, is_active, auto_create, note, user_id, user_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.name.trim(),
          input.customerId,
          input.serviceAddressId,
          input.assetId,
          input.title.trim(),
          text(input.description),
          input.priority,
          input.ownerUserId,
          text(input.ownerName),
          input.locationId,
          input.frequency,
          input.dayOfMonth,
          input.frequency === 'weekly' ? input.dayOfWeek : null,
          input.startsOn,
          text(input.endsOn),
          input.leadDays,
          input.isActive ? 1 : 0,
          input.autoCreate ? 1 : 0,
          text(input.note),
          actor.userId,
          actor.userName,
        ],
      )
      id = Number((result as { insertId: number }).insertId)
    } else {
      /*
       * `last_generated_for` is deliberately NOT writable here. It is the cursor
       * the catch-up walks from, and letting a form set it would let somebody
       * silently skip periods — or re-raise ones already done.
       */
      await tx.execute(
        `UPDATE job_series
            SET name = ?, customer_id = ?, service_address_id = ?, asset_id = ?, title = ?,
                description = ?, priority = ?, owner_user_id = ?, owner_name = ?,
                location_id = ?, frequency = ?, day_of_month = ?, day_of_week = ?,
                starts_on = ?, ends_on = ?, lead_days = ?, is_active = ?, auto_create = ?,
                note = ?
          WHERE id = ?`,
        [
          input.name.trim(),
          input.customerId,
          input.serviceAddressId,
          input.assetId,
          input.title.trim(),
          text(input.description),
          input.priority,
          input.ownerUserId,
          text(input.ownerName),
          input.locationId,
          input.frequency,
          input.dayOfMonth,
          input.frequency === 'weekly' ? input.dayOfWeek : null,
          input.startsOn,
          text(input.endsOn),
          input.leadDays,
          input.isActive ? 1 : 0,
          input.autoCreate ? 1 : 0,
          text(input.note),
          id,
        ],
      )
      await tx.execute(`DELETE FROM job_series_headlines WHERE series_id = ?`, [id])
    }

    for (const [index, headlineId] of input.headlineIds.entries()) {
      await tx.execute(
        `INSERT IGNORE INTO job_series_headlines (series_id, headline_id, sort_order)
         VALUES (?,?,?)`,
        [id, headlineId, index],
      )
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: null,
      action: input.id === null ? 'series_created' : 'series_updated',
      detail: `${input.name.trim()} — ${FREQUENCY_LABELS[input.frequency].toLowerCase()}`,
    })

    return { ok: true as const, id }
  })
}

/**
 * Delete a schedule.
 *
 * Allowed even once it has raised jobs, unlike most deletes in this module —
 * `fk_jcard_series` is SET NULL, so the work survives and simply stops saying
 * which schedule produced it. A schedule is a plan, not a record of anything that
 * happened; the jobs are the record.
 *
 * The count is still reported back so the screen can say what will be unlinked.
 */
export async function deleteJobSeries(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<SeriesActionResult> {
  const series = await siteQueryOne<Row>(
    siteId,
    `SELECT s.id, s.name,
            (SELECT COUNT(*) FROM job_cards j WHERE j.series_id = s.id) AS n
       FROM job_series s WHERE s.id = ?`,
    [id],
  )
  if (!series) return { ok: false, error: 'That schedule no longer exists.' }

  await siteExecute(siteId, `DELETE FROM job_series WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: null,
    action: 'series_deleted',
    detail: `${series.name}${Number(series.n) > 0 ? ` — ${series.n} job(s) unlinked` : ''}`,
  })
  return { ok: true }
}

/* ── Generating ────────────────────────────────────────────────────────────── */

export type GeneratedJob = {
  seriesId: number
  seriesName: string
  jobId: number
  documentNumber: string | null
  forDate: string
}

export type GenerateJobsResult = {
  created: GeneratedJob[]
  /** Reported, never silent: a truncated catch-up must not read as a complete one. */
  skipped: { seriesId: number; seriesName: string; reason: string }[]
}

/**
 * Raise every job that is due.
 *
 * Safe to call as often as you like — see the claim below. Safe to call rarely
 * too: a series left un-ticked for three months raises three jobs on the next
 * run, one per period, each dated for its own period rather than today.
 *
 * `manualSeriesId` bills one series regardless of its auto_create switch, which is
 * what the "raise it now" button on the schedule screen does.
 */
export async function generateDueJobs(
  siteId: number,
  actor: Actor,
  asAt = today(),
  manualSeriesId?: number,
): Promise<GenerateJobsResult> {
  const result: GenerateJobsResult = { created: [], skipped: [] }

  const all = await listJobSeries(siteId, { includeInactive: false })
  const wanted = manualSeriesId ? all.filter((s) => s.id === manualSeriesId) : all

  for (const series of wanted) {
    // auto_create off means the tick leaves it alone; a manual run overrides that,
    // because somebody pressing a button IS the decision the switch guards.
    if (!series.autoCreate && !manualSeriesId) continue

    const { periods, capped } = duePeriods(
      {
        frequency: series.frequency,
        dayOfMonth: series.dayOfMonth,
        dayOfWeek: series.dayOfWeek,
        startsOn: series.startsOn,
        endsOn: series.endsOn,
        lastGeneratedFor: series.lastGeneratedFor,
      },
      asAt,
      series.leadDays,
    )

    if (capped) {
      result.skipped.push({
        seriesId: series.id,
        seriesName: series.name,
        reason:
          'More than 24 periods are outstanding, so only the first 24 were raised. Check the start date and the last generated period.',
      })
    }

    for (const forDate of periods) {
      const raised = await raiseOne(siteId, actor, series, forDate)
      if (raised.ok) {
        result.created.push(raised.job)
      } else if (raised.reason) {
        result.skipped.push({
          seriesId: series.id,
          seriesName: series.name,
          reason: raised.reason,
        })
      }
      // A period already claimed by a concurrent tick returns a null reason and is
      // deliberately not reported — it means the guarantee did its job.
    }
  }

  if (result.created.length > 0) {
    await logActivity(siteId, actor, {
      entity: 'job_card',
      entityId: null,
      action: 'series_generate',
      detail: `Raised ${result.created.length} recurring job${result.created.length === 1 ? '' : 's'}`,
    })
  }
  return result
}

type RaiseOutcome =
  | { ok: true; job: GeneratedJob }
  | { ok: false; reason: string | null }

/**
 * Raise ONE occurrence.
 *
 * The claim-then-create sequence is the delicate part of this whole feature, so it
 * lives in one readable function — exactly as billOnePeriod does for contracts.
 */
async function raiseOne(
  siteId: number,
  actor: Actor,
  series: JobSeries,
  forDate: string,
): Promise<RaiseOutcome> {
  // ── 1. CLAIM the period, before anything is created. ───────────────────────
  //
  // uq_series_period on (series_id, for_date) means a second tick racing this one
  // fails HERE, having written nothing.
  let claimId: number
  try {
    const claim = await siteExecute(
      siteId,
      `INSERT INTO job_series_runs (series_id, for_date, status) VALUES (?,?,'created')`,
      [series.id, forDate],
    )
    claimId = claim.insertId
  } catch {
    // Already claimed. Silent by design — this is the guarantee working.
    return { ok: false, reason: null }
  }

  try {
    const status = await statusForRole(siteId, 'new')
    if (!status) {
      throw new Error('No status is marked as where new jobs start.')
    }

    /*
     * A FRESH job, built from the template — never a clone of the previous
     * occurrence. Section 19: no checklist answers, no time entries, no costs, no
     * comments, no files carry forward. Cloning a row would bring all of it, and a
     * service sheet arriving pre-signed by last quarter is worse than none.
     *
     * reported_at is the PERIOD, not now: a job raised 14 days early for the 30th
     * is a job for the 30th, and its SLA clock should start then.
     */
    const jobId = await siteTransaction(siteId, async (tx) => {
      const [inserted] = await tx.execute(
        `INSERT INTO job_cards
           (status, customer_id, customer_name, service_address_id, asset_id, location_id,
            status_id, priority, owner_user_id, owner_name, title, description,
            reported_at, due_at, source, series_id, user_id, user_name)
         VALUES ('open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'internal', ?, ?, ?)`,
        [
          series.customerId,
          series.customerName,
          series.serviceAddressId,
          series.assetId,
          series.locationId,
          status.id,
          series.priority,
          series.ownerUserId,
          series.ownerName ?? '',
          series.title,
          series.description,
          `${forDate} 08:00:00`,
          `${forDate} 17:00:00`,
          series.id,
          actor.userId,
          actor.userName,
        ],
      )
      const newId = Number((inserted as { insertId: number }).insertId)

      await applyDeadlinesTx(tx, siteId, newId, series.priority, `${forDate} 08:00:00`)

      // LAST write before commit — nextDocumentNumber holds the sequence lock.
      const documentNumber = await nextDocumentNumber(tx, 'job_card')
      await tx.execute(`UPDATE job_cards SET document_number = ? WHERE id = ?`, [
        documentNumber,
        newId,
      ])

      await logActivityTx(tx, actor, {
        entity: 'job_card',
        entityId: newId,
        action: 'created',
        detail: `${documentNumber} — raised by ${series.name} for ${forDate}`,
      })
      return newId
    })

    /*
     * The kinds of work, AFTER the job exists and outside its transaction:
     * applyHeadlines opens its own, and nesting would deadlock on the same rows.
     * A failure here leaves a job with no checks rather than no job — the right
     * way round, since a job with a missing checklist can be fixed by hand.
     */
    if (series.headlineIds.length > 0) {
      await applyHeadlines(siteId, actor, jobId, series.headlineIds).catch(() => {})
    }

    // ── 2. Record what the claim produced, and move the cursor. ──────────────
    await siteExecute(siteId, `UPDATE job_series_runs SET job_card_id = ? WHERE id = ?`, [
      jobId,
      claimId,
    ])
    /*
     * GREATEST, so a manual back-fill of an older period cannot wind the cursor
     * backwards and re-raise everything after it.
     */
    await siteExecute(
      siteId,
      `UPDATE job_series
          SET last_generated_for = GREATEST(COALESCE(last_generated_for, ?), ?)
        WHERE id = ?`,
      [forDate, forDate, series.id],
    )

    const created = await siteQueryOne<Row>(
      siteId,
      `SELECT document_number FROM job_cards WHERE id = ?`,
      [jobId],
    )
    return {
      ok: true,
      job: {
        seriesId: series.id,
        seriesName: series.name,
        jobId,
        documentNumber: text(created?.document_number),
        forDate,
      },
    }
  } catch (error) {
    /*
     * The claim STAYS, marked failed. Deleting it would let the next tick try the
     * same period again and again; leaving it says "this period was attempted and
     * needs looking at", which reconcileJobSeries reports.
     */
    const message = error instanceof Error ? error.message : 'Could not raise the job.'
    await siteExecute(
      siteId,
      `UPDATE job_series_runs SET status = 'failed', error = ? WHERE id = ?`,
      [message.slice(0, 400), claimId],
    )
    return { ok: false, reason: message }
  }
}

export type SeriesRun = {
  id: number
  forDate: string
  jobId: number | null
  documentNumber: string | null
  status: string
  error: string | null
  createdAt: string | null
}

/** What a schedule has raised, newest first. */
export async function seriesRuns(
  siteId: number,
  seriesId: number,
  limit = 60,
): Promise<SeriesRun[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT r.id, r.for_date, r.job_card_id, r.status, r.error, r.created_at,
            j.document_number
       FROM job_series_runs r
       LEFT JOIN job_cards j ON j.id = r.job_card_id
      WHERE r.series_id = ?
      ORDER BY r.for_date DESC, r.id DESC
      LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
    [seriesId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    forDate: dateOnly(r.for_date) ?? '',
    jobId: r.job_card_id === null ? null : Number(r.job_card_id),
    documentNumber: text(r.document_number),
    status: String(r.status),
    error: text(r.error),
    createdAt: dateOnly(r.created_at),
  }))
}

/**
 * Which schedule raised this job, if any.
 *
 * Its own small query rather than widening `JobCard`, which a dozen screens read.
 * Returns null for a job somebody logged by hand, which is most of them.
 */
export async function jobSeriesFor(
  siteId: number,
  jobId: number,
): Promise<{ seriesId: number; name: string; frequencyLabel: string; forDate: string | null } | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT s.id, s.name, s.frequency,
            (SELECT r.for_date FROM job_series_runs r WHERE r.job_card_id = j.id LIMIT 1) AS for_date
       FROM job_cards j
       JOIN job_series s ON s.id = j.series_id
      WHERE j.id = ?`,
    [jobId],
  )
  if (!row) return null
  return {
    seriesId: Number(row.id),
    name: String(row.name),
    frequencyLabel: FREQUENCY_LABELS[String(row.frequency) as RecurringFrequency],
    forDate: dateOnly(row.for_date),
  }
}

export type SeriesDrift = {
  /**
   * A claim that never produced a job and is not marked failed.
   *
   * The run died between claiming the period and creating the job. The period is
   * blocked — the unique key means the next tick will not retry it — so this is
   * the one drift here that silently loses work.
   */
  strandedClaims: { runId: number; seriesId: number; seriesName: string; forDate: string }[]
  /** Claims that recorded a failure, with the reason. */
  failedRuns: { runId: number; seriesId: number; seriesName: string; forDate: string; error: string | null }[]
  /**
   * A cursor ahead of the newest claim.
   *
   * last_generated_for is moved beside the claim, so a cursor past every claimed
   * period means periods were skipped — and skipped periods are never retried.
   */
  cursorAhead: { seriesId: number; seriesName: string; cursor: string; newestClaim: string | null }[]
}

/** Drift between what was claimed and what was raised. Reports, never repairs. */
export async function reconcileJobSeries(siteId: number): Promise<SeriesDrift> {
  const [stranded, failed, cursor] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT r.id, r.series_id, r.for_date, s.name
         FROM job_series_runs r JOIN job_series s ON s.id = r.series_id
        WHERE r.job_card_id IS NULL AND r.status = 'created'`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT r.id, r.series_id, r.for_date, r.error, s.name
         FROM job_series_runs r JOIN job_series s ON s.id = r.series_id
        WHERE r.status = 'failed'`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT s.id, s.name, s.last_generated_for,
              (SELECT MAX(r.for_date) FROM job_series_runs r WHERE r.series_id = s.id) AS newest
         FROM job_series s
        WHERE s.last_generated_for IS NOT NULL
       HAVING newest IS NULL OR s.last_generated_for > newest`,
    ),
  ])

  return {
    strandedClaims: stranded.map((r) => ({
      runId: Number(r.id),
      seriesId: Number(r.series_id),
      seriesName: String(r.name),
      forDate: dateOnly(r.for_date) ?? '',
    })),
    failedRuns: failed.map((r) => ({
      runId: Number(r.id),
      seriesId: Number(r.series_id),
      seriesName: String(r.name),
      forDate: dateOnly(r.for_date) ?? '',
      error: text(r.error),
    })),
    cursorAhead: cursor.map((r) => ({
      seriesId: Number(r.id),
      seriesName: String(r.name),
      cursor: dateOnly(r.last_generated_for) ?? '',
      newestClaim: dateOnly(r.newest),
    })),
  }
}

/** How many schedules owe a job right now. For the dashboard. */
export async function seriesDueCount(siteId: number, asAt = today()): Promise<number> {
  const all = await listJobSeries(siteId, { includeInactive: false })
  let due = 0
  for (const series of all) {
    if (!series.autoCreate) continue
    const { periods } = duePeriods(
      {
        frequency: series.frequency,
        dayOfMonth: series.dayOfMonth,
        dayOfWeek: series.dayOfWeek,
        startsOn: series.startsOn,
        endsOn: series.endsOn,
        lastGeneratedFor: series.lastGeneratedFor,
      },
      asAt,
      series.leadDays,
    )
    if (periods.length > 0) due++
  }
  return due
}
