import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { customerDbPrefix } from './customerDb'
import { logActivity, type Actor } from './activityLog'
import { getSetting } from './settings'
import { sendAs, isConfiguredFor } from '../mail'
import { createFeedbackToken } from '../feedbackToken'

/**
 * What the customer thought of the work.
 *
 * ── ONE STAR AND ONE SENTENCE ──────────────────────────────────────────────
 *
 * The migration header argues the shape. In short: a survey is a different
 * product, and the thing a service business actually needs is a number it can
 * trend and a sentence it can read.
 *
 * ── ASKING AND ANSWERING ARE DIFFERENT EVENTS ──────────────────────────────
 *
 * requestFeedback writes a row with requested_at and no rating. The customer
 * answering fills in the rest. That is what makes a response RATE real: rows
 * with no responded_at are people who were asked and said nothing, and they are
 * the majority.
 *
 * ── SENDING NEVER BLOCKS CLOSING A JOB ─────────────────────────────────────
 *
 * The orderNotify contract, and it matters more here than anywhere: a mail
 * server being down must never be the reason somebody cannot close a job. Every
 * path returns a reason instead of throwing, and the caller is free to ignore it.
 */

type Row = RowDataPacket & Record<string, unknown>

/** DATETIME columns arrive as driver Dates parsed as UTC. */
const wallClock = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return (
      `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}` +
      ` ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`
    )
  }
  return String(value)
}

export type JobFeedback = {
  id: number
  jobId: number
  jobNumber: string | null
  jobTitle: string
  customerId: number | null
  customerName: string | null
  requestedAt: string | null
  respondedAt: string | null
  rating: number | null
  comment: string | null
  seenAt: string | null
  seenByName: string | null
}

export type FeedbackResult = { ok: true } | { ok: false; error: string }

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function mapFeedback(r: Row): JobFeedback {
  return {
    id: Number(r.id),
    jobId: Number(r.job_card_id),
    jobNumber: text(r.document_number),
    jobTitle: String(r.title ?? ''),
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    customerName: text(r.customer_name),
    requestedAt: wallClock(r.requested_at),
    respondedAt: wallClock(r.responded_at),
    rating: r.rating === null ? null : Number(r.rating),
    comment: text(r.comment),
    seenAt: wallClock(r.seen_at),
    seenByName: text(r.seen_by_name),
  }
}

const SELECT = `
  SELECT f.*, j.document_number, j.title, j.customer_name
    FROM job_feedback f
    JOIN job_cards j ON j.id = f.job_card_id`

/** Whether the business has switched this on at all. */
export async function feedbackEnabled(siteId: number): Promise<boolean> {
  const value = await getSetting(siteId, 'job_feedback_enabled').catch(() => '0')
  return value === '1'
}

export async function feedbackFor(siteId: number, jobId: number): Promise<JobFeedback | null> {
  try {
    const row = await siteQueryOne<Row>(siteId, `${SELECT} WHERE f.job_card_id = ? LIMIT 1`, [jobId])
    return row ? mapFeedback(row) : null
  } catch {
    return null
  }
}

/**
 * Every answer, newest first. For the report screen.
 *
 * `unseenOnly` is the one somebody opens in the morning: a bad rating nobody has
 * read is the most expensive row in this table.
 */
export async function listFeedback(
  siteId: number,
  opts: { unseenOnly?: boolean; limit?: number } = {},
): Promise<JobFeedback[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `${SELECT}
        WHERE f.responded_at IS NOT NULL
          ${opts.unseenOnly ? 'AND f.seen_at IS NULL' : ''}
        ORDER BY f.responded_at DESC
        LIMIT ?`,
      [opts.limit ?? 200],
    )
    return rows.map(mapFeedback)
  } catch {
    return []
  }
}

/**
 * Ask the customer what they thought.
 *
 * ── IT CLAIMS THE ROW BEFORE IT SENDS ──────────────────────────────────────
 *
 * INSERT first, email second, and the unique key on job_card_id is what makes
 * closing a job twice send one email rather than two. The same claim-then-act
 * shape the automations use, for the same reason.
 *
 * Returns a reason rather than throwing, always. The caller is closeJob, and a
 * job that could not be closed because a mail server was slow is a far worse
 * outcome than a customer who was never asked.
 */
export async function requestFeedback(
  siteId: number,
  jobId: number,
): Promise<{ sent: boolean; skipped?: string }> {
  try {
    if (!(await feedbackEnabled(siteId))) return { sent: false, skipped: 'disabled' }

    const cdb = await customerDbPrefix(siteId)

    const job = await siteQueryOne<Row>(
      siteId,
      `SELECT j.id, j.document_number, j.title, j.customer_id, j.customer_name,
              j.customer_email, c.email AS account_email
         FROM job_cards j
         LEFT JOIN ${cdb}customers c ON c.id = j.customer_id
        WHERE j.id = ?`,
      [jobId],
    )
    if (!job) return { sent: false, skipped: 'no such job' }

    /*
     * The job's snapshot first, the account second.
     *
     * A job carries the address it was logged with, which is the one the person
     * who did the work confirmed. Falling back to the account catches the
     * ordinary case of a job logged without one.
     */
    const to = text(job.customer_email) ?? text(job.account_email)
    if (!to) return { sent: false, skipped: 'no email address' }

    // The claim. A duplicate key means this job was already asked, which is the
    // guard against a job closed, reopened and closed again asking twice.
    try {
      await siteExecute(
        siteId,
        `INSERT INTO job_feedback (job_card_id, customer_id) VALUES (?, ?)`,
        [jobId, job.customer_id ?? null],
      )
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        return { sent: false, skipped: 'already asked' }
      }
      throw error
    }

    if (!(await isConfiguredFor(siteId))) return { sent: false, skipped: 'mail not configured' }

    const intro = await getSetting(siteId, 'job_feedback_intro').catch(
      () => 'Thank you for your business. How did we do?',
    )
    const token = await createFeedbackToken({ siteId, jobId })
    const base = process.env.APP_URL ?? ''
    const url = `${base}/feedback/${token}`
    const label = text(job.document_number) ?? `Job ${jobId}`

    const result = await sendAs(siteId, {
      to,
      subject: `How did we do? — ${label}`,
      text: `${intro}\n\n${label}: ${String(job.title ?? '')}\n\nRate the work here:\n${url}\n\nIt takes a few seconds, and it is the only thing we will send about it.`,
    })

    if (!result.ok) return { sent: false, skipped: result.error }
    return { sent: true }
  } catch (error) {
    // Never throws. See the header.
    return { sent: false, skipped: (error as Error).message }
  }
}

/**
 * The customer's answer, from the public page.
 *
 * ── NO ACTOR, BECAUSE THERE IS NO USER ─────────────────────────────────────
 *
 * Everything else in src/lib/site takes an Actor. This does not: whoever is
 * holding the link is a customer, not a user of this system, and inventing an
 * actor for them would put a name in the audit trail that means nothing.
 *
 * ── AN UPDATE, NEVER AN INSERT ─────────────────────────────────────────────
 *
 * The row exists because the request created it. That is the whole access
 * control: a token for a job nobody was asked about updates nothing, so a valid
 * signature alone cannot manufacture feedback.
 */
export async function recordFeedback(
  siteId: number,
  jobId: number,
  rating: number,
  comment: string | null,
): Promise<FeedbackResult> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: 'Choose between one and five stars.' }
  }
  const clean = comment === null ? null : comment.trim().slice(0, 1000)

  try {
    const result = await siteExecute(
      siteId,
      `UPDATE job_feedback
          SET rating = ?, comment = ?, responded_at = NOW(),
              /* Re-answering makes it unread again: a changed rating is news. */
              seen_at = NULL, seen_by_user_id = NULL, seen_by_name = NULL
        WHERE job_card_id = ?`,
      [rating, clean === '' ? null : clean, jobId],
    )
    if (result.affectedRows === 0) {
      return { ok: false, error: 'That link is no longer valid.' }
    }

    await logActivity(
      siteId,
      // The customer is not a user. Recorded as the system, with the detail
      // saying who it was really from.
      { userId: 0, userName: 'The customer' },
      {
        entity: 'job_card',
        entityId: jobId,
        action: 'feedback_received',
        detail: `Rated ${rating} out of 5${clean ? ` — "${clean.slice(0, 80)}"` : ''}`,
      },
    ).catch(() => {})

    return { ok: true }
  } catch {
    return { ok: false, error: 'That could not be saved. Please try again.' }
  }
}

/** Somebody in the business has read it. */
export async function markSeen(
  siteId: number,
  actor: Actor,
  jobId: number,
): Promise<FeedbackResult> {
  try {
    await siteExecute(
      siteId,
      `UPDATE job_feedback
          SET seen_at = NOW(), seen_by_user_id = ?, seen_by_name = ?
        WHERE job_card_id = ? AND responded_at IS NOT NULL`,
      [actor.userId, actor.userName, jobId],
    )
    return { ok: true }
  } catch {
    return { ok: false, error: 'That could not be saved.' }
  }
}

export type FeedbackSummary = {
  asked: number
  answered: number
  /** Answered as a share of asked, 0-100. The number worth watching. */
  responseRate: number
  average: number | null
  unseen: number
  /** How many of each rating, 1 to 5. */
  spread: Record<number, number>
}

export async function feedbackSummary(siteId: number): Promise<FeedbackSummary> {
  const empty: FeedbackSummary = {
    asked: 0,
    answered: 0,
    responseRate: 0,
    average: null,
    unseen: 0,
    spread: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  }
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS asked,
              SUM(responded_at IS NOT NULL) AS answered,
              AVG(rating) AS average,
              SUM(responded_at IS NOT NULL AND seen_at IS NULL) AS unseen
         FROM job_feedback`,
    )
    const spreadRows = await siteQuery<Row>(
      siteId,
      `SELECT rating, COUNT(*) AS n FROM job_feedback WHERE rating IS NOT NULL GROUP BY rating`,
    )
    const spread = { ...empty.spread }
    for (const s of spreadRows) spread[Number(s.rating)] = Number(s.n)

    const asked = Number(row?.asked ?? 0)
    const answered = Number(row?.answered ?? 0)
    return {
      asked,
      answered,
      responseRate: asked === 0 ? 0 : Math.round((answered / asked) * 100),
      average: row?.average === null || row?.average === undefined ? null : Number(row.average),
      unseen: Number(row?.unseen ?? 0),
      spread,
    }
  } catch {
    return empty
  }
}

export type FeedbackDrift = {
  /**
   * Asked a long time ago, never answered, and now past the link's life.
   *
   * Not a bug — most people do not answer — but worth seeing as a number,
   * because a response rate of zero usually means the emails are not arriving
   * rather than that every customer ignored them.
   */
  lapsed: { jobId: number; jobNumber: string | null; requestedAt: string | null }[]
  /** Answered badly and nobody has looked. The expensive one. */
  unseenPoor: { jobId: number; jobNumber: string | null; rating: number; comment: string | null }[]
}

/** Reports, never repairs. */
export async function reconcileJobFeedback(siteId: number): Promise<FeedbackDrift> {
  const empty: FeedbackDrift = { lapsed: [], unseenPoor: [] }
  try {
    // 60 days, matching the token's own life — a link past that cannot be used
    // even if the customer finds the email.
    const lapsedRows = await siteQuery<Row>(
      siteId,
      `${SELECT}
        WHERE f.responded_at IS NULL
          AND f.requested_at < DATE_SUB(NOW(), INTERVAL 60 DAY)
        ORDER BY f.requested_at DESC LIMIT 200`,
    )
    const poorRows = await siteQuery<Row>(
      siteId,
      `${SELECT}
        WHERE f.responded_at IS NOT NULL AND f.seen_at IS NULL AND f.rating <= 3
        ORDER BY f.rating, f.responded_at DESC LIMIT 200`,
    )
    return {
      lapsed: lapsedRows.map((r) => ({
        jobId: Number(r.job_card_id),
        jobNumber: text(r.document_number),
        requestedAt: wallClock(r.requested_at),
      })),
      unseenPoor: poorRows.map((r) => ({
        jobId: Number(r.job_card_id),
        jobNumber: text(r.document_number),
        rating: Number(r.rating),
        comment: text(r.comment),
      })),
    }
  } catch {
    return empty
  }
}
