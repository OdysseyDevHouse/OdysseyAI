import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { getSetting } from './settings'
import { logActivity, type Actor } from './activityLog'
// notifyAbout only: it already resolves the recipient list itself, including the
// owner from the column. Working the list out here as well would be a second copy
// of the rule about who hears what.
import { notifyAbout } from './jobPeople'
import { billableLines, invoiceJob } from './jobInvoicing'

/**
 * The three things that should happen without anybody clicking.
 *
 * Section 12 asks for a workflow automation engine; the plan argued that out in
 * favour of six NAMED, separately-switchable rules. Three arrived with phase 14
 * as notifications. These are the other three, and what they have in common is
 * that a CLOCK fires them rather than a person -- which is the whole reason they
 * need a claim table and the notifications did not.
 *
 * ── CLAIM FIRST, ACT SECOND ────────────────────────────────────────────────
 *
 * Every run inserts its claim row BEFORE doing anything, under a unique key of
 * (job, event, day). A second tick racing the first fails on that insert having
 * done nothing at all.
 *
 * The ordering is the point. Claiming after the work would mean a crash in
 * between does the work twice; claiming before means a crash leaves a claim with
 * no delivery -- which reconcileJobAutomations reports, and which a person can
 * act on. Sending an email twice is the failure nobody notices until somebody
 * complains. Not sending it is the failure a screen can find.
 *
 * ── EVERY TICK IS TOLERANT ─────────────────────────────────────────────────
 *
 * A site without migration 121 must not break the sweep for every other site, so
 * each automation swallows its own errors and REPORTS them in the result. The
 * caller counts what happened rather than discovering it threw.
 */

type Row = RowDataPacket & Record<string, unknown>

export type AutomationEvent =
  | 'respond_breach'
  | 'resolve_breach'
  | 'visit_reminder'
  | 'auto_invoice'

export type AutomationOutcome = {
  event: AutomationEvent
  claimed: number
  done: number
  failed: number
  skipped: 'off' | 'unmigrated' | null
}

/** A date as YYYY-MM-DD in the site wall clock, matching how DATE columns read. */
function dayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function switchedOn(siteId: number, key: Parameters<typeof getSetting>[1]): Promise<boolean> {
  const value = await getSetting(siteId, key).catch(() => '0')
  return value === '1'
}

/**
 * Take the claim, or find that somebody already has it.
 *
 * Returns the claim id, or null when the row already existed. A plain INSERT
 * rather than INSERT IGNORE: IGNORE swallows every error including a broken
 * column, and a claim that silently never inserts would make an automation
 * silently never run.
 */
async function claim(
  siteId: number,
  jobId: number,
  event: AutomationEvent,
  forDate: string,
): Promise<number | null> {
  try {
    const res = await siteExecute(
      siteId,
      `INSERT INTO job_automation_runs (job_card_id, event, for_date) VALUES (?,?,?)`,
      [jobId, event, forDate],
    )
    return res.insertId
  } catch (error) {
    // A duplicate is the NORMAL outcome on every tick after the first, so it is
    // not an error. Anything else is, and must not be mistaken for one.
    const code = (error as { code?: string }).code
    if (code === 'ER_DUP_ENTRY') return null
    throw error
  }
}

async function settle(
  siteId: number,
  claimId: number,
  status: 'done' | 'failed',
  detail: string | null,
  resultId: number | null = null,
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE job_automation_runs SET status = ?, detail = ?, result_id = ? WHERE id = ?`,
    [status, detail?.slice(0, 400) ?? null, resultId, claimId],
  )
}

/** The system as an actor, matching the house convention in contracts/tick.ts. */
const ROBOT: Actor = { userId: 0, userName: 'Automation' }

/* ── 1. Escalate a breached SLA ────────────────────────────────────────────── */

/**
 * Tell the owner and followers when a job has passed a promise.
 *
 * Two separate events, not one escalation: a job can breach its RESPONSE
 * promise, get responded to, and then breach its RESOLUTION promise as well.
 * Folding them together would let the second be swallowed by the first claim and
 * never reported.
 *
 * The breach is read straight off the deadline columns rather than recomputed --
 * applyDeadlinesTx already did the business-hours arithmetic when the job was
 * logged or re-prioritised, and doing it twice is how the screen and the email
 * come to disagree about whether something is late.
 */
export async function escalateBreaches(siteId: number): Promise<AutomationOutcome[]> {
  const respond: AutomationOutcome = {
    event: 'respond_breach', claimed: 0, done: 0, failed: 0, skipped: null,
  }
  const resolve: AutomationOutcome = {
    event: 'resolve_breach', claimed: 0, done: 0, failed: 0, skipped: null,
  }

  if (!(await switchedOn(siteId, 'job_auto_escalate'))) {
    respond.skipped = 'off'
    resolve.skipped = 'off'
    return [respond, resolve]
  }

  const today = dayKey(Date.now())

  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT j.id, j.document_number, j.title, j.customer_name, j.priority,
              (j.respond_by IS NOT NULL AND j.responded_at IS NULL AND j.respond_by < NOW())
                AS respond_past,
              (j.resolve_by IS NOT NULL AND j.resolve_by < NOW()) AS resolve_past
         FROM job_cards j
        WHERE j.status = 'open'
          AND (
            (j.respond_by IS NOT NULL AND j.responded_at IS NULL AND j.respond_by < NOW())
            OR (j.resolve_by IS NOT NULL AND j.resolve_by < NOW())
          )
        ORDER BY j.id
        LIMIT 500`,
    )

    for (const r of rows) {
      const jobId = Number(r.id)
      const label = `${String(r.document_number ?? `Job ${jobId}`)} — ${String(r.title)}`

      /*
       * Which deadline actually passed, decided by SQL and read back as a flag.
       *
       * TWO bugs live here, both found by (J23).
       *
       * The first: the WHERE matches a row on EITHER deadline, so classifying on
       * `IS NOT NULL` alone escalated a job that had only missed its RESPONSE
       * time as unresolved too -- permanently consuming the resolution claim for
       * the day, so the real breach would never be reported.
       *
       * The second: fixing that by comparing in JavaScript is wrong as well.
       * DATETIME columns come back as driver Dates parsed as UTC (the pool sets
       * timezone 'Z'), while NOW() runs in the session timezone -- so the two
       * clocks disagree and a genuinely breached job silently fails the JS test
       * while passing the SQL one.
       *
       * Asking SQL for both answers keeps one clock. The flags below are the SAME
       * expressions as the WHERE, so the filter and the classification cannot
       * drift apart.
       */
      const breaches: AutomationEvent[] = []
      if (Number(r.respond_past) === 1) breaches.push('respond_breach')
      if (Number(r.resolve_past) === 1) breaches.push('resolve_breach')

      for (const event of breaches) {
        const bucket = event === 'respond_breach' ? respond : resolve
        const claimId = await claim(siteId, jobId, event, today)
        if (claimId === null) continue
        bucket.claimed++
        try {
          const which = event === 'respond_breach' ? 'not been responded to' : 'not been resolved'
          const sent = await notifyAbout(
            siteId,
            jobId,
            'status',
            `Overdue: ${label}`,
            `${label} has ${which} by the time promised for a ${String(r.priority)} job.`,
            null,
          )
          await settle(siteId, claimId, 'done', `notified ${sent.sent}`)
          bucket.done++
        } catch (error) {
          await settle(siteId, claimId, 'failed', String(error).slice(0, 400)).catch(() => {})
          bucket.failed++
        }
      }
    }
  } catch {
    // Migration 121 or 113 not applied on this site.
    respond.skipped = 'unmigrated'
    resolve.skipped = 'unmigrated'
  }

  return [respond, resolve]
}

/* ── 2. Remind before a visit ──────────────────────────────────────────────── */

/**
 * Tell whoever is going that they are going, the evening before.
 *
 * Claimed against the DATE OF THE VISIT, not today. Moving a booking to another
 * day therefore earns a fresh reminder rather than being silenced by yesterday's
 * claim -- which is what a technician needs, since the change is the thing worth
 * hearing about.
 */
export async function remindVisits(siteId: number): Promise<AutomationOutcome> {
  const out: AutomationOutcome = {
    event: 'visit_reminder', claimed: 0, done: 0, failed: 0, skipped: null,
  }
  if (!(await switchedOn(siteId, 'job_auto_visit_reminder'))) {
    out.skipped = 'off'
    return out
  }

  const rawHours = await getSetting(siteId, 'job_auto_visit_hours').catch(() => '16')
  const hours = Math.max(1, Math.min(168, Number(rawHours) || 16))

  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT a.id, a.job_card_id, a.starts_at, j.document_number, j.title,
              j.customer_name
         FROM job_card_appointments a
         JOIN job_cards j ON j.id = a.job_card_id
        WHERE a.status IN ('scheduled','confirmed')
          AND j.status = 'open'
          AND a.starts_at > NOW()
          AND a.starts_at <= DATE_ADD(NOW(), INTERVAL ? HOUR)
        ORDER BY a.starts_at
        LIMIT 500`,
      [hours],
    )

    for (const r of rows) {
      const jobId = Number(r.job_card_id)
      const startsAt = r.starts_at as Date
      const visitDay = dayKey(startsAt.getTime())

      const claimId = await claim(siteId, jobId, 'visit_reminder', visitDay)
      if (claimId === null) continue
      out.claimed++

      try {
        // Whoever is on the VISIT, not everybody on the job: a reminder about
        // tomorrow morning belongs to the person going, and sending it to every
        // follower is how the useful ones get filtered out with the rest.
        const [assignees] = [
          await siteQuery<Row>(
            siteId,
            `SELECT user_id FROM job_appointment_assignees WHERE appointment_id = ?`,
            [Number(r.id)],
          ),
        ]
        const ids = assignees.map((a) => Number(a.user_id))

        const label = `${String(r.document_number ?? `Job ${jobId}`)} — ${String(r.title)}`
        const when = startsAt.toISOString().slice(0, 16).replace('T', ' ')
        const sent = await notifyAbout(
          siteId,
          jobId,
          'status',
          `Tomorrow: ${label}`,
          `You are booked to visit ${String(r.customer_name ?? 'a customer')} at ${when} for ${label}.`,
          null,
          // No assignee on the visit yet means nobody specific to tell, so it
          // falls back to the job. A visit with nobody on it is worth somebody
          // seeing the evening before.
          ids.length > 0 ? ids : undefined,
        )
        await settle(siteId, claimId, 'done', `notified ${sent.sent}`)
        out.done++
      } catch (error) {
        await settle(siteId, claimId, 'failed', String(error).slice(0, 400)).catch(() => {})
        out.failed++
      }
    }
  } catch {
    out.skipped = 'unmigrated'
  }

  return out
}

/* ── 3. Raise the invoice on completion ────────────────────────────────────── */

/**
 * Draft an invoice for a job that closed with billable work on it.
 *
 * ── WHY THIS ONE IS OFF BY DEFAULT ─────────────────────────────────────────
 *
 * The other two send an email, where a wrong one is noise. This creates
 * PAPERWORK against a real customer account: a job closed by mistake would leave
 * an invoice somebody has to find and void, and voiding is not free -- it is a
 * number issued and cancelled on a sequence somebody audits.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 *
 * It raises a DRAFT and stops. Finalising remains a human act through
 * finaliseDocument, the one posting engine, exactly as invoiceJob has always
 * required. Nothing here writes a movement, a transaction or a GL mirror.
 *
 * It also bills the FULL outstanding quantity of every billable line and makes
 * no judgement about partials. A partial invoice is a decision about what a
 * customer owes, and that is not a decision a clock should make.
 */
export async function autoInvoiceClosed(siteId: number): Promise<AutomationOutcome> {
  const out: AutomationOutcome = {
    event: 'auto_invoice', claimed: 0, done: 0, failed: 0, skipped: null,
  }
  if (!(await switchedOn(siteId, 'job_auto_invoice'))) {
    out.skipped = 'off'
    return out
  }

  try {
    /*
     * Closed in the last 7 days, not all time. Switching this on for the first
     * time on a site with four years of history must not raise four years of
     * invoices -- which is the single most expensive mistake this file could
     * make, and the reason the window is here rather than a TODO.
     */
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT j.id, j.document_number, j.closed_at
         FROM job_cards j
        WHERE j.status = 'closed'
          AND j.closed_at IS NOT NULL
          AND j.closed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          AND j.customer_id IS NOT NULL
        ORDER BY j.closed_at DESC
        LIMIT 200`,
    )

    for (const r of rows) {
      const jobId = Number(r.id)
      const closedDay = dayKey((r.closed_at as Date).getTime())

      // Nothing to bill is not a claim: a job with no billable lines should stay
      // eligible in case somebody adds one and re-closes it.
      const lines = await billableLines(siteId, jobId)
      if (lines.length === 0) continue

      const claimId = await claim(siteId, jobId, 'auto_invoice', closedDay)
      if (claimId === null) continue
      out.claimed++

      try {
        const result = await invoiceJob(
          siteId,
          ROBOT,
          jobId,
          // outstandingQty, not qty minus invoicedQty: the module already
          // computes it, and a second subtraction here is a second place for the
          // partial-invoice arithmetic to drift.
          lines.map((l) => ({ lineId: l.id, qty: l.outstandingQty })),
          { notes: 'Raised automatically when the job was closed.' },
        )
        if (result.ok) {
          await settle(siteId, claimId, 'done', `${result.lineCount} line(s)`, result.invoiceId)
          await logActivity(siteId, ROBOT, {
            entity: 'job_card',
            entityId: jobId,
            action: 'auto_invoiced',
            detail: `Draft invoice raised automatically — ${result.lineCount} line(s)`,
          }).catch(() => {})
          out.done++
        } else {
          // A REFUSAL is recorded, not swallowed. invoiceJob refuses for good
          // reasons (no customer, nothing billable, a closed period) and each is
          // something a person should be able to read back.
          await settle(siteId, claimId, 'failed', result.error)
          out.failed++
        }
      } catch (error) {
        await settle(siteId, claimId, 'failed', String(error).slice(0, 400)).catch(() => {})
        out.failed++
      }
    }
  } catch {
    out.skipped = 'unmigrated'
  }

  return out
}

/** Everything, in one sweep. The tick route calls this and nothing else. */
export async function runAutomations(siteId: number): Promise<AutomationOutcome[]> {
  const [breaches, visits, invoices] = await Promise.all([
    escalateBreaches(siteId).catch(() => []),
    remindVisits(siteId).catch(
      (): AutomationOutcome => ({
        event: 'visit_reminder', claimed: 0, done: 0, failed: 0, skipped: 'unmigrated',
      }),
    ),
    autoInvoiceClosed(siteId).catch(
      (): AutomationOutcome => ({
        event: 'auto_invoice', claimed: 0, done: 0, failed: 0, skipped: 'unmigrated',
      }),
    ),
  ])
  return [...breaches, visits, invoices]
}

/* ── History and drift ─────────────────────────────────────────────────────── */

export type AutomationRun = {
  id: number
  jobId: number
  documentNumber: string | null
  jobTitle: string
  event: AutomationEvent
  forDate: string
  status: string
  detail: string | null
  resultId: number | null
  createdAt: Date
}

/** What has run lately, newest first. */
export async function automationRuns(siteId: number, limit = 100): Promise<AutomationRun[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT a.id, a.job_card_id, a.event, a.for_date, a.status, a.detail,
              a.result_id, a.created_at, j.document_number, j.title
         FROM job_automation_runs a
         JOIN job_cards j ON j.id = a.job_card_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ?`,
      [Math.max(1, Math.min(500, Math.floor(limit)))],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      jobId: Number(r.job_card_id),
      documentNumber: r.document_number === null ? null : String(r.document_number),
      jobTitle: String(r.title),
      event: String(r.event) as AutomationEvent,
      forDate: String(r.for_date).slice(0, 10),
      status: String(r.status),
      detail: r.detail === null ? null : String(r.detail),
      resultId: r.result_id === null ? null : Number(r.result_id),
      createdAt: r.created_at as Date,
    }))
  } catch {
    return []
  }
}

export type AutomationDrift = {
  /**
   * A claim that never settled.
   *
   * The serious one, and the reason claiming comes first. The unique key means
   * this job/event/day will NEVER be retried, so an escalation that died mid-send
   * is silently lost -- unless something reports it, which is this.
   *
   * Anything older than an hour, so a tick running right now is not accused.
   */
  stuckClaims: AutomationRun[]
  /** Runs that failed with a reason worth reading. */
  failures: AutomationRun[]
}

/** Reports, never repairs. */
export async function reconcileJobAutomations(siteId: number): Promise<AutomationDrift> {
  const empty: AutomationDrift = { stuckClaims: [], failures: [] }
  try {
    const all = await automationRuns(siteId, 500)
    const hourAgo = Date.now() - 60 * 60 * 1000
    return {
      stuckClaims: all.filter(
        (r) => r.status === 'claimed' && r.createdAt.getTime() < hourAgo,
      ),
      failures: all.filter((r) => r.status === 'failed'),
    }
  } catch {
    return empty
  }
}

/** How many jobs are sitting past a promise right now. Drives the tile. */
export async function overdueCount(siteId: number): Promise<number> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM job_cards
        WHERE status = 'open'
          AND ((respond_by IS NOT NULL AND responded_at IS NULL AND respond_by < NOW())
            OR (resolve_by IS NOT NULL AND resolve_by < NOW()))`,
    )
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}
