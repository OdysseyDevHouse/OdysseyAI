import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { workedMinutes, toHours, formatDuration } from '../timeModel'
import { hourlyCostOf } from '../employmentModel'
import { getEmployment } from './employment'
import { getSetting } from './settings'
import { logActivity, logActivityTx, type Actor } from './activityLog'

/**
 * Time worked on a job.
 *
 * ── NO NEW TABLE, DELIBERATELY ─────────────────────────────────────────────
 *
 * 104 added `staff_time_entries.job_card_id` and left it unwritten for this
 * phase. That column is the whole of the storage.
 *
 * 054 wrote a long header arguing itself out of reusing `shifts` for staff time,
 * and every one of those arguments runs the OTHER way here: staff_time_entries is
 * already per-person rather than per-terminal, already covers people who never
 * touch a till, already carries the s31 correction audit trail a labour dispute
 * needs, and already feeds timesheets.ts and staff_pay_periods. A separate
 * job_time_entries table would put a technician Tuesday in two places and make the
 * payroll total a UNION — the exact failure 054 exists to prevent.
 *
 * ── ONE OPEN TIMER, AND WHY THE INDEX STAYS ────────────────────────────────
 *
 * `uq_open_entry` is a generated column holding the user id while an entry is open
 * and NULLing on close (054:88), so the DATABASE refuses a second concurrent entry
 * for one person. The PRD asks for a permissioned bypass; this module does not
 * provide one, and that is a decision rather than an omission.
 *
 * Relaxing that index cannot be undone: once two overlapping rows exist, no
 * migration can restore the constraint without choosing which of somebody's hours
 * to delete. And the failure it prevents is the one that matters most — an hour
 * paid twice, or billed to two customers.
 *
 * So starting a timer on job B CLOSES the open one on job A and says so. That
 * covers the real case (the technician moved from one job to the next) with one
 * button and no decision, and the case it does not cover — genuinely working two
 * jobs in one hour — is answered by editing the minutes afterwards, which
 * `editEntry` in staffTime.ts already audits.
 *
 * ── THE MONEY IS SNAPSHOTTED ───────────────────────────────────────────────
 *
 * Cost from `user_employment.hourly_rate` via hourlyCostOf(); charge-out from the
 * labour product named in settings. Both written onto the job line at the moment
 * the timer stops, so next year's raise does not restate last year's margin —
 * the same reason 042 snapshots a commission rate.
 */

export type JobTimeEntry = {
  id: number
  userId: number
  userName: string
  startedAt: string
  endedAt: string | null
  minutes: number | null
  note: string | null
  /** True while the clock is still running. */
  isOpen: boolean
  /** The labour line this entry produced, once it was stopped and priced. */
  lineId: number | null
}

export type JobTimeSummary = {
  entries: JobTimeEntry[]
  /** Minutes across every CLOSED entry. An open one has no length yet. */
  recordedMinutes: number
  /** The one still running, if any. */
  openEntry: JobTimeEntry | null
}

export type TimerResult =
  | { ok: true; entryId: number; stoppedOther: { jobNumber: string | null; minutes: number } | null }
  | { ok: false; error: string }

export type StopResult =
  | { ok: true; minutes: number; lineId: number | null; priced: boolean }
  | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

/** A DATETIME as a stable wall clock. See the header in jobAppointments.ts. */
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

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

/**
 * Minutes on a job entry.
 *
 * `workedMinutes` takes a break allowance because a shift has one; a job timer
 * does not — somebody who stops for lunch stops the clock, and the switch-closes-
 * previous rule means that is one button. Passing 0 keeps the arithmetic identical
 * to the one payroll uses rather than reimplementing it.
 */
function entryMinutes(startedAt: string, endedAt: string | null): number | null {
  return workedMinutes(startedAt, endedAt, 0)
}

/**
 * The VAT rate a labour line carries.
 *
 * The labour product's own SELLING rate, exactly as a sales line gets it — there
 * is no `default_vat_rate` setting, because VAT lives in `vat_rates` with an
 * is_default flag and each product points at the rate it uses.
 *
 * Falling back to the default rate rather than a hard-coded 15 means a zero-rated
 * business gets zero without a code change.
 */
async function labourVatRate(siteId: number, productId: number | null): Promise<number> {
  if (productId !== null) {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT v.rate FROM products p
         JOIN vat_rates v ON v.id = p.selling_vat_rate_id
        WHERE p.id = ?`,
      [productId],
    )
    if (row) return toNum(row.rate)
  }

  /*
   * `vat_type = 'sales'`, not 'selling'.
   *
   * The COLUMN on products is `selling_vat_rate_id` and the ENUM value is 'sales',
   * which is the kind of near-miss that returns no rows rather than an error — the
   * first version of this query matched nothing and silently put 0% VAT on a
   * billable labour line. Checked against the seeds in 001_products.sql.
   */
  const fallback = await siteQueryOne<Row>(
    siteId,
    `SELECT rate FROM vat_rates WHERE vat_type = 'sales' AND is_default = 1 LIMIT 1`,
  )
  return toNum(fallback?.rate)
}

function mapEntry(row: Row): JobTimeEntry {
  const startedAt = wallClock(row.started_at) ?? ''
  const endedAt = wallClock(row.ended_at)
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    userName: String(row.user_name ?? ''),
    startedAt,
    endedAt,
    // entryMinutes wraps workedMinutes(), the same function timesheets and payroll
    // use, so a job's idea of an hour cannot differ from the one somebody is paid
    // for.
    minutes: entryMinutes(startedAt, endedAt),
    note: text(row.note),
    isOpen: endedAt === null,
    lineId: row.line_id === null || row.line_id === undefined ? null : Number(row.line_id),
  }
}

/**
 * Every stretch of time booked to a job.
 *
 * The labour line is found by `time_entry_id`, the column 104 declared for this —
 * so an entry and the money it produced can be walked in both directions.
 */
export async function jobTime(siteId: number, jobId: number): Promise<JobTimeSummary> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id, t.user_id, t.user_name, t.started_at, t.ended_at, t.note,
            (SELECT l.id FROM job_card_lines l WHERE l.time_entry_id = t.id LIMIT 1) AS line_id
       FROM staff_time_entries t
      WHERE t.job_card_id = ?
      ORDER BY t.started_at DESC, t.id DESC`,
    [jobId],
  )

  const entries = rows.map(mapEntry)
  return {
    entries,
    recordedMinutes: entries.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0),
    openEntry: entries.find((entry) => entry.isOpen) ?? null,
  }
}

/** The entry this person has open right now, whatever it is against. */
export async function openEntryForUser(
  siteId: number,
  userId: number,
): Promise<(JobTimeEntry & { jobCardId: number | null; jobNumber: string | null }) | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT t.id, t.user_id, t.user_name, t.started_at, t.ended_at, t.note, t.job_card_id,
            j.document_number AS job_number, NULL AS line_id
       FROM staff_time_entries t
       LEFT JOIN job_cards j ON j.id = t.job_card_id
      WHERE t.user_id = ? AND t.ended_at IS NULL
      LIMIT 1`,
    [userId],
  )
  if (!row) return null
  return {
    ...mapEntry(row),
    jobCardId: row.job_card_id === null ? null : Number(row.job_card_id),
    jobNumber: text(row.job_number),
  }
}

/**
 * Start the clock on a job.
 *
 * ── SWITCHING, NOT REFUSING ────────────────────────────────────────────────
 *
 * An open entry elsewhere is closed first, and the caller is told which job it
 * was and how long it ran. Refusing instead would make the technician navigate to
 * the other job to stop it — which on a phone, between two houses, is how the
 * timer stops being used at all.
 *
 * Stopping the previous entry deliberately does NOT price it into a labour line.
 * That is `stopJobTimer`'s job and it needs a decision about who pays; doing it as
 * a side effect of starting somewhere else would put an unreviewed charge on a job
 * nobody was looking at. The entry keeps its minutes and appears on that job's
 * time list as unpriced, which is the flag that gets it dealt with.
 */
export async function startJobTimer(
  siteId: number,
  actor: Actor,
  jobId: number,
  userId: number,
  userName: string,
): Promise<TimerResult> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, document_number FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'That job is closed. Reopen it before booking time to it.' }
  }

  return siteTransaction(siteId, async (tx) => {
    // Lock the person's open row, so two taps a hundred milliseconds apart cannot
    // both find nothing and both insert.
    const [openRows] = await tx.query<Row[]>(
      `SELECT t.id, t.started_at, t.job_card_id, j.document_number AS job_number
         FROM staff_time_entries t
         LEFT JOIN job_cards j ON j.id = t.job_card_id
        WHERE t.user_id = ? AND t.ended_at IS NULL
        FOR UPDATE`,
      [userId],
    )
    const open = openRows[0]

    let stoppedOther: { jobNumber: string | null; minutes: number } | null = null

    if (open) {
      if (Number(open.job_card_id) === jobId) {
        return { ok: false as const, error: 'The clock is already running on this job.' }
      }

      await tx.execute(
        `UPDATE staff_time_entries SET ended_at = NOW() WHERE id = ? AND ended_at IS NULL`,
        [Number(open.id)],
      )
      const [closedRows] = await tx.query<Row[]>(
        `SELECT started_at, ended_at FROM staff_time_entries WHERE id = ?`,
        [Number(open.id)],
      )
      const minutes =
        entryMinutes(
          wallClock(closedRows[0]?.started_at) ?? '',
          wallClock(closedRows[0]?.ended_at),
        ) ?? 0
      stoppedOther = { jobNumber: text(open.job_number), minutes }

      // Logged against the job that LOST the time, so its own history says where
      // the technician went.
      if (open.job_card_id !== null) {
        await logActivityTx(tx, actor, {
          entity: 'job_card',
          entityId: Number(open.job_card_id),
          action: 'timer_switched',
          detail: `${userName} moved to ${job.document_number ?? `job #${jobId}`} after ${formatDuration(minutes)} — the time is recorded but not yet priced`,
        })
      }
    }

    /*
     * source = 'manual'.
     *
     * The TimeSource union is 'pin' | 'manual' | 'import' and a job timer is none
     * of them exactly — but it is nearer manual than pin: a person pressed a
     * button in the app rather than entering a PIN at a till. Widening the union
     * would touch timesheets, payroll and the staff screens for a distinction
     * nothing downstream acts on; the job_card_id is what identifies these.
     */
    const [res] = await tx.execute(
      `INSERT INTO staff_time_entries (user_id, user_name, started_at, source, job_card_id)
       VALUES (?, ?, NOW(), 'manual', ?)`,
      [userId, userName.slice(0, 120), jobId],
    )
    const entryId = Number((res as { insertId: number }).insertId)

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'timer_started',
      detail: stoppedOther
        ? `${userName} started the clock, after ${formatDuration(stoppedOther.minutes)} on ${stoppedOther.jobNumber ?? 'another job'}`
        : `${userName} started the clock`,
    })

    return { ok: true as const, entryId, stoppedOther }
  })
}

/**
 * Stop the clock, and turn the minutes into a labour line.
 *
 * ── WHY A LINE AT ALL ──────────────────────────────────────────────────────
 *
 * Time that is only a time entry never reaches a customer or a margin. The whole
 * point of booking hours to a job is that they become a cost and, usually, a
 * charge — so stopping the timer produces a `labour` line whose qty is the hours.
 *
 * It lands in `pending` when the money is unknown, and `additional` when both
 * figures resolved, because the PRD requires a technician to be able to record
 * work without choosing a commercial position. Somebody with jobs.bill_decide
 * moves it on.
 *
 * ── WHAT UNPRICED MEANS ────────────────────────────────────────────────────
 *
 * No employment record, or no labour product configured. The line is still
 * created — with a zero it is honest about — because losing the hours because a
 * setting is blank would be worse than a line somebody has to price.
 */
export async function stopJobTimer(
  siteId: number,
  actor: Actor,
  jobId: number,
  userId: number,
  note?: string | null,
): Promise<StopResult> {
  const open = await siteQueryOne<Row>(
    siteId,
    `SELECT id, user_id, user_name, started_at, job_card_id
       FROM staff_time_entries
      WHERE user_id = ? AND ended_at IS NULL`,
    [userId],
  )
  if (!open) return { ok: false, error: 'The clock is not running.' }
  if (Number(open.job_card_id) !== jobId) {
    return { ok: false, error: 'The clock is running on a different job.' }
  }

  // Both rates resolved BEFORE the transaction: they are reads against employment
  // and products, and holding a write lock while doing them buys nothing.
  const [employment, labourProductId] = await Promise.all([
    getEmployment(siteId, Number(open.user_id), true),
    getSetting(siteId, 'job_labour_product_id'),
  ])
  const costPerHour = employment ? hourlyCostOf(employment) : null

  let pricePerHour: number | null = null
  let productId: number | null = null
  let productCode: string | null = null

  if (labourProductId) {
    const product = await siteQueryOne<Row>(
      siteId,
      `SELECT id, code, price_incl FROM products WHERE id = ?`,
      [Number(labourProductId)],
    )
    if (product) {
      productId = Number(product.id)
      productCode = text(product.code)
      pricePerHour = toNum(product.price_incl)
    }
  }

  /*
   * The labour product's own selling VAT rate, exactly as a sales line gets it.
   *
   * There is no `default_vat_rate` setting — VAT lives in `vat_rates` with an
   * is_default flag, and a product points at the rate it carries. Falling back to
   * the default rate rather than a hard 15 means a zero-rated business gets zero
   * without a code change.
   */
  const vatRate = await labourVatRate(siteId, productId)

  return siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE staff_time_entries SET ended_at = NOW(), note = COALESCE(?, note) WHERE id = ?`,
      [text(note ?? null), Number(open.id)],
    )

    const [rows] = await tx.query<Row[]>(
      `SELECT started_at, ended_at FROM staff_time_entries WHERE id = ?`,
      [Number(open.id)],
    )
    const minutes =
      entryMinutes(wallClock(rows[0]?.started_at) ?? '', wallClock(rows[0]?.ended_at)) ?? 0

    /*
     * A timer stopped within the same minute it started produces zero hours, and a
     * zero-hour labour line is noise on the costing tab. The entry is kept — it is
     * a record that somebody pressed the button — and no line is made.
     */
    if (minutes <= 0) {
      await logActivityTx(tx, actor, {
        entity: 'job_card',
        entityId: jobId,
        action: 'timer_stopped',
        detail: `${String(open.user_name ?? '')} stopped the clock after less than a minute — no labour line made`,
      })
      return { ok: true as const, minutes: 0, lineId: null, priced: false }
    }

    const hours = round(toHours(minutes), 3)
    const priced = costPerHour !== null && pricePerHour !== null

    const [maxRow] = await tx.query<Row[]>(
      `SELECT COALESCE(MAX(line_number), 0) AS n FROM job_card_lines WHERE job_card_id = ?`,
      [jobId],
    )
    const lineNumber = Number(maxRow[0]?.n ?? 0) + 1

    const [lineRes] = await tx.execute(
      `INSERT INTO job_card_lines
         (job_card_id, line_number, line_kind, billing_state, product_id, product_code,
          description, qty, unit_cost_excl, unit_price_incl, vat_rate_pct, discount_pct,
          time_entry_id, note)
       VALUES (?, ?, 'labour', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        jobId,
        lineNumber,
        // Unpriced work has no commercial position to take, so it waits for one.
        priced ? 'additional' : 'pending',
        productId,
        productCode,
        `${String(open.user_name ?? 'Labour')} — ${formatDuration(minutes)}`,
        hours.toFixed(3),
        (costPerHour ?? 0).toFixed(4),
        (pricePerHour ?? 0).toFixed(4),
        vatRate.toFixed(3),
        Number(open.id),
        text(note ?? null),
      ] as never,
    )
    const lineId = Number((lineRes as { insertId: number }).insertId)

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'timer_stopped',
      detail:
        `${String(open.user_name ?? '')} recorded ${formatDuration(minutes)}` +
        (priced
          ? ` at ${pricePerHour!.toFixed(2)} an hour`
          : costPerHour === null
            ? ' — no pay rate on file, so the line needs pricing'
            : ' — no labour product configured, so the line needs pricing'),
    })

    return { ok: true as const, minutes, lineId, priced }
  })
}

/**
 * Book time somebody forgot to clock.
 *
 * The commonest real correction: a technician who worked all afternoon and never
 * pressed start. Kept separate from `startJobTimer` because it takes a length
 * rather than a moment, and separate from staffTime's `createManual` because that
 * one knows nothing about producing a labour line.
 *
 * ── WHY THIS CANNOT COLLIDE WITH AN OPEN TIMER ─────────────────────────────
 *
 * It inserts a CLOSED entry — both timestamps set — so `open_user_id` is NULL from
 * the start and `uq_open_entry` never sees it. Somebody can add yesterday's
 * forgotten hours while today's clock is running.
 */
export async function addJobTime(
  siteId: number,
  actor: Actor,
  jobId: number,
  input: { userId: number; userName: string; startedAt: string; minutes: number; note?: string | null },
): Promise<StopResult> {
  if (input.minutes <= 0) return { ok: false, error: 'How long was worked?' }
  if (input.minutes > 24 * 60) return { ok: false, error: 'A single entry cannot exceed a day.' }
  if (!input.startedAt) return { ok: false, error: 'When did it start?' }

  const job = await siteQueryOne<Row>(siteId, `SELECT id, status FROM job_cards WHERE id = ?`, [jobId])
  if (!job) return { ok: false, error: 'That job no longer exists.' }

  const [employment, labourProductId] = await Promise.all([
    getEmployment(siteId, input.userId, true),
    getSetting(siteId, 'job_labour_product_id'),
  ])
  const costPerHour = employment ? hourlyCostOf(employment) : null

  let pricePerHour: number | null = null
  let productId: number | null = null
  let productCode: string | null = null
  if (labourProductId) {
    const product = await siteQueryOne<Row>(
      siteId,
      `SELECT id, code, price_incl FROM products WHERE id = ?`,
      [Number(labourProductId)],
    )
    if (product) {
      productId = Number(product.id)
      productCode = text(product.code)
      pricePerHour = toNum(product.price_incl)
    }
  }

  /*
   * The labour product's own selling VAT rate, exactly as a sales line gets it.
   *
   * There is no `default_vat_rate` setting — VAT lives in `vat_rates` with an
   * is_default flag, and a product points at the rate it carries. Falling back to
   * the default rate rather than a hard 15 means a zero-rated business gets zero
   * without a code change.
   */
  const vatRate = await labourVatRate(siteId, productId)
  const priced = costPerHour !== null && pricePerHour !== null
  const hours = round(toHours(input.minutes), 3)

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO staff_time_entries
         (user_id, user_name, started_at, ended_at, source, job_card_id, note)
       VALUES (?, ?, ?, DATE_ADD(?, INTERVAL ? MINUTE), 'manual', ?, ?)`,
      [
        input.userId,
        input.userName.slice(0, 120),
        input.startedAt,
        input.startedAt,
        input.minutes,
        jobId,
        text(input.note ?? null),
      ] as never,
    )
    const entryId = Number((res as { insertId: number }).insertId)

    const [maxRow] = await tx.query<Row[]>(
      `SELECT COALESCE(MAX(line_number), 0) AS n FROM job_card_lines WHERE job_card_id = ?`,
      [jobId],
    )
    const lineNumber = Number(maxRow[0]?.n ?? 0) + 1

    const [lineRes] = await tx.execute(
      `INSERT INTO job_card_lines
         (job_card_id, line_number, line_kind, billing_state, product_id, product_code,
          description, qty, unit_cost_excl, unit_price_incl, vat_rate_pct, discount_pct,
          time_entry_id, note)
       VALUES (?, ?, 'labour', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        jobId,
        lineNumber,
        priced ? 'additional' : 'pending',
        productId,
        productCode,
        `${input.userName} — ${formatDuration(input.minutes)}`,
        hours.toFixed(3),
        (costPerHour ?? 0).toFixed(4),
        (pricePerHour ?? 0).toFixed(4),
        vatRate.toFixed(3),
        entryId,
        text(input.note ?? null),
      ] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'time_added',
      detail: `${formatDuration(input.minutes)} booked for ${input.userName} on ${input.startedAt.slice(0, 10)}${priced ? '' : ' — needs pricing'}`,
    })

    return { ok: true as const, minutes: input.minutes, lineId: Number((lineRes as { insertId: number }).insertId), priced }
  })
}

/**
 * Remove a time entry and the labour line it produced.
 *
 * Both together, in one transaction: an entry without its line understates the
 * job cost, and a line without its entry is a charge with no evidence behind it.
 *
 * Refused once the line has been invoiced — the customer has been charged for
 * those hours, and the remedy is a credit note rather than deleting the record
 * that justifies them.
 */
export async function deleteJobTime(
  siteId: number,
  actor: Actor,
  jobId: number,
  entryId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT t.id, t.user_name, t.started_at, t.ended_at, t.job_card_id,
              l.id AS line_id, l.invoiced_doc_id, l.invoiced_qty
         FROM staff_time_entries t
         LEFT JOIN job_card_lines l ON l.time_entry_id = t.id
        WHERE t.id = ?`,
      [entryId],
    )
    const entry = rows[0]
    if (!entry) return { ok: false as const, error: 'That time entry no longer exists.' }
    if (Number(entry.job_card_id) !== jobId) {
      return { ok: false as const, error: 'That entry belongs to a different job.' }
    }
    if (entry.ended_at === null) {
      return { ok: false as const, error: 'Stop the clock before removing the entry.' }
    }
    if (entry.invoiced_doc_id !== null || toNum(entry.invoiced_qty) > 0) {
      return {
        ok: false as const,
        error: 'Those hours have been invoiced. Credit the invoice rather than deleting the record.',
      }
    }

    if (entry.line_id !== null) {
      await tx.execute(`DELETE FROM job_card_lines WHERE id = ?`, [Number(entry.line_id)])
    }
    await tx.execute(`DELETE FROM staff_time_entries WHERE id = ?`, [entryId])

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'time_removed',
      detail: `${String(entry.user_name ?? '')} — entry of ${wallClock(entry.started_at)?.slice(0, 16).replace('T', ' ')} removed`,
    })

    return { ok: true as const }
  })
}

export type LabourDrift = {
  /** Closed job entries with no labour line — hours nobody will ever be paid for. */
  unpriced: { entryId: number; jobId: number; jobNumber: string | null; userName: string; minutes: number }[]
  /** Labour lines whose time entry has gone. A charge with no evidence. */
  orphanedLines: { lineId: number; jobId: number; description: string }[]
  /** Timers left running for more than a day. Somebody forgot to stop. */
  forgotten: { entryId: number; jobId: number; jobNumber: string | null; userName: string; startedAt: string }[]
}

/**
 * Drift between the clock and the costing. Reports, never repairs.
 *
 * The first is the one that costs money: a technician's afternoon recorded as time
 * and never turned into a line is an hour the job cost that nobody billed and no
 * margin report knows about.
 */
export async function reconcileJobTime(siteId: number): Promise<LabourDrift> {
  const [unpriced, orphaned, forgotten] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT t.id, t.job_card_id, t.user_name, t.started_at, t.ended_at,
              j.document_number AS job_number
         FROM staff_time_entries t
         JOIN job_cards j ON j.id = t.job_card_id
        WHERE t.job_card_id IS NOT NULL
          AND t.ended_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM job_card_lines l WHERE l.time_entry_id = t.id)`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT l.id, l.job_card_id, l.description
         FROM job_card_lines l
        WHERE l.time_entry_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM staff_time_entries t WHERE t.id = l.time_entry_id)`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT t.id, t.job_card_id, t.user_name, t.started_at, j.document_number AS job_number
         FROM staff_time_entries t
         JOIN job_cards j ON j.id = t.job_card_id
        WHERE t.ended_at IS NULL AND t.started_at < DATE_SUB(NOW(), INTERVAL 1 DAY)`,
    ),
  ])

  return {
    unpriced: unpriced.map((r) => ({
      entryId: Number(r.id),
      jobId: Number(r.job_card_id),
      jobNumber: text(r.job_number),
      userName: String(r.user_name ?? ''),
      minutes: entryMinutes(wallClock(r.started_at) ?? '', wallClock(r.ended_at)) ?? 0,
    })),
    orphanedLines: orphaned.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      description: String(r.description),
    })),
    forgotten: forgotten.map((r) => ({
      entryId: Number(r.id),
      jobId: Number(r.job_card_id),
      jobNumber: text(r.job_number),
      userName: String(r.user_name ?? ''),
      startedAt: wallClock(r.started_at) ?? '',
    })),
  }
}

/** Re-exported so a server caller has one import. */
export { formatDuration }
