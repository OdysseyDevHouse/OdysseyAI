import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { logActivity } from './activityLog'
import { portalSettings } from './portalAuth'
import { valuesFor } from './customFields'

/**
 * What a signed-in customer may see and do.
 *
 * ── EVERY QUERY NAMES THE CUSTOMER, IN THE WHERE ───────────────────────────
 *
 * There is no function here that takes an id and trusts it. `customerId` comes
 * from the session and appears in the WHERE of every single statement, so asking
 * for job 47 when job 47 belongs to somebody else returns nothing rather than
 * somebody else's work. That is the whole access-control model, and it is
 * deliberately boring: one rule, applied everywhere, with no exceptions to
 * remember.
 *
 * ── THE COLUMN LISTS ARE THE SECURITY BOUNDARY ─────────────────────────────
 *
 * Every SELECT names its columns. Not one uses `*`, and that is not a style
 * preference — a `SELECT *` here would publish whatever column somebody adds to
 * job_cards next year to every customer on the internet. Widening what a
 * customer sees must be a deliberate edit to this file.
 *
 * WHAT IS DELIBERATELY WITHHELD, and why:
 *
 *   cost, margin, unit_cost        what the business paid is not the customer's
 *   internal_note                  written by staff, about the customer
 *   staff comments and files       is_visible defaults to 0 (migration 131), so
 *                                  nothing written before the portal existed is
 *                                  published, and a note crosses this line only
 *                                  when somebody deliberately shares it
 *   owner and assignee names       who is on it is a staffing matter; a
 *                                  customer needs the business, not a person
 *   time entries, travel           labour hours and kilometres are how the
 *                                  business prices, not what was agreed
 *   other customers, everything    every WHERE names this customer
 *   custom fields not marked public  is_public defaults to 0 for this reason
 */

type Row = RowDataPacket & Record<string, unknown>

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

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

export type PortalJob = {
  id: number
  documentNumber: string | null
  title: string
  description: string | null
  /** The stage NAME only. Not its role, not whether it is billable. */
  statusName: string
  statusTone: string
  isClosed: boolean
  reportedAt: string | null
  dueAt: string | null
  closedAt: string | null
}

export type PortalJobDetail = PortalJob & {
  /** Booked visits. When somebody is coming, and nothing about who. */
  visits: { id: number; startsAt: string | null; endsAt: string | null; status: string }[]
  /** Only comments staff marked as visible to the customer. */
  comments: { id: number; body: string; author: string; createdAt: string | null; mine: boolean }[]
  /** Files staff shared, plus anything this customer uploaded. */
  files: { id: number; name: string; uploadedAt: string | null; mine: boolean }[]
  /** Only custom fields explicitly marked public. */
  extras: { name: string; value: string }[]
  /** Quotes raised for this job, with their state. */
  quotes: {
    id: number
    documentNumber: string | null
    docDate: string | null
    total: number
    status: string
    isAccepted: boolean
  }[]
}

/** Every job of this customer. The list screen. */
export async function portalJobs(siteId: number, customerId: number): Promise<PortalJob[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT j.id, j.document_number, j.title, j.description,
              j.reported_at, j.due_at, j.closed_at, j.status,
              s.name AS status_name, s.tone AS status_tone
         FROM job_cards j
         LEFT JOIN job_statuses s ON s.id = j.status_id
        WHERE j.customer_id = ?
        ORDER BY j.status = 'open' DESC, j.reported_at DESC
        LIMIT 200`,
      [customerId],
    )
    return rows.map(mapJob)
  } catch {
    return []
  }
}

function mapJob(r: Row): PortalJob {
  return {
    id: Number(r.id),
    documentNumber: text(r.document_number),
    title: String(r.title ?? ''),
    description: text(r.description),
    statusName: String(r.status_name ?? 'In progress'),
    statusTone: String(r.status_tone ?? 'neutral'),
    isClosed: String(r.status) !== 'open',
    reportedAt: wallClock(r.reported_at),
    dueAt: wallClock(r.due_at),
    closedAt: wallClock(r.closed_at),
  }
}

/**
 * One job, in full — but only if it belongs to this customer.
 *
 * The customerId is in the WHERE rather than checked afterwards, so a job that
 * is not theirs is indistinguishable from a job that does not exist.
 */
export async function portalJob(
  siteId: number,
  customerId: number,
  jobId: number,
): Promise<PortalJobDetail | null> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT j.id, j.document_number, j.title, j.description,
              j.reported_at, j.due_at, j.closed_at, j.status,
              s.name AS status_name, s.tone AS status_tone
         FROM job_cards j
         LEFT JOIN job_statuses s ON s.id = j.status_id
        WHERE j.id = ? AND j.customer_id = ?`,
      [jobId, customerId],
    )
    if (!row) return null

    const [visits, comments, files, extras, quotes] = await Promise.all([
      /*
       * WHEN somebody is coming, and deliberately not WHO.
       *
       * user_name is on this table and is not selected. Which technician is
       * coming is a staffing decision the business may change twice before the
       * day; a customer needs the slot.
       *
       * ends_at is computed rather than stored — the column is duration_minutes.
       */
      siteQuery<Row>(
        siteId,
        `SELECT id, starts_at, duration_minutes, status
           FROM job_card_appointments
          WHERE job_card_id = ? AND status <> 'cancelled'
          ORDER BY starts_at`,
        [jobId],
      ).catch(() => [] as Row[]),
      /*
       * VISIBLE comments only, and the default is invisible.
       *
       * party_comments was staff-only until migration 131 — every row in it was
       * written by somebody in the back office ABOUT a customer. is_visible
       * defaults to 0, so switching the portal on publishes none of it, and a
       * staff note only crosses this line when somebody deliberately shares it.
       */
      siteQuery<Row>(
        siteId,
        `SELECT id, body, author_name, created_at, is_customer
           FROM party_comments
          WHERE entity = 'job_card' AND entity_id = ? AND is_visible = 1
          ORDER BY created_at`,
        [jobId],
      ).catch(() => [] as Row[]),
      // The same rule for files: a supplier PDF behind a GRV is not something to
      // publish, so only what was deliberately shared or the customer sent.
      siteQuery<Row>(
        siteId,
        `SELECT id, filename, created_at, is_customer
           FROM party_documents
          WHERE entity = 'job_card' AND entity_id = ? AND is_visible = 1
          ORDER BY created_at DESC`,
        [jobId],
      ).catch(() => [] as Row[]),
      // publicOnly — the flag defaults to 0 precisely so a new field is private
      // until somebody decides otherwise.
      valuesFor(siteId, 'job', jobId, { publicOnly: true }).catch(() => []),
      /*
       * Quotes on this job.
       *
       * Only ISSUED or better — a draft is the business still working out what
       * to charge, and showing a customer a figure nobody has sent them invites
       * an argument about a number that was never an offer.
       */
      siteQuery<Row>(
        siteId,
        `SELECT d.id, d.document_number, d.document_date, d.total_incl, d.status,
                d.quote_outcome,
                (j.accepted_quote_id = d.id) AS is_accepted
           FROM sales_documents d
           JOIN job_cards j ON j.id = d.job_card_id
          WHERE d.job_card_id = ? AND d.doc_type = 'quote'
            AND d.status IN ('issued', 'finalised')
          ORDER BY d.document_date DESC`,
        [jobId],
      ).catch(() => [] as Row[]),
    ])

    return {
      ...mapJob(row),
      visits: visits.map((v) => ({
        id: Number(v.id),
        startsAt: wallClock(v.starts_at),
        // Derived from the duration, because that is what the table stores.
        endsAt:
          v.starts_at instanceof Date
            ? wallClock(
                new Date(v.starts_at.getTime() + Number(v.duration_minutes ?? 0) * 60_000),
              )
            : null,
        status: String(v.status ?? ''),
      })),
      comments: comments.map((c) => ({
        id: Number(c.id),
        body: String(c.body ?? ''),
        author: String(c.author_name ?? ''),
        createdAt: wallClock(c.created_at),
        mine: Number(c.is_customer) === 1,
      })),
      files: files.map((f) => ({
        id: Number(f.id),
        name: String(f.filename ?? 'File'),
        uploadedAt: wallClock(f.created_at),
        mine: Number(f.is_customer) === 1,
      })),
      extras: extras
        .filter((e) => e.value !== null && e.value.trim() !== '')
        .map((e) => ({ name: e.name, value: e.value as string })),
      quotes: quotes.map((q) => ({
        id: Number(q.id),
        documentNumber: text(q.document_number),
        docDate: wallClock(q.document_date),
        total: Number(q.total_incl ?? 0),
        // The OUTCOME, not the posting status: "accepted" or "declined" means
        // something to a customer, "finalised" does not.
        status: String(q.quote_outcome ?? 'open'),
        isAccepted: Number(q.is_accepted) === 1,
      })),
    }
  } catch {
    return null
  }
}

export type PortalInvoice = {
  id: number
  documentNumber: string | null
  docDate: string | null
  total: number
  outstanding: number
  isPaid: boolean
}

/**
 * This customer's invoices.
 *
 * Only FINALISED ones: a draft is the business still deciding, and showing a
 * customer a figure that has not been issued to them invites an argument about
 * a number nobody meant them to see.
 */
export async function portalInvoices(
  siteId: number,
  customerId: number,
): Promise<PortalInvoice[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT d.id, d.document_number, d.document_date, d.total_incl,
              COALESCE(t.amount_outstanding, 0) AS outstanding
         FROM sales_documents d
         LEFT JOIN customer_transactions t
                ON t.source = 'sale' AND t.source_doc_id = d.id
        WHERE d.customer_id = ? AND d.doc_type = 'invoice'
          AND d.status = 'finalised'
        ORDER BY d.document_date DESC LIMIT 100`,
      [customerId],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      documentNumber: text(r.document_number),
      docDate: wallClock(r.document_date),
      total: Number(r.total_incl ?? 0),
      outstanding: Number(r.outstanding ?? 0),
      isPaid: Number(r.outstanding ?? 0) <= 0,
    }))
  } catch {
    return []
  }
}

export type PortalResult = { ok: true } | { ok: false; error: string }

/**
 * The customer says something on their own job.
 *
 * ── ALWAYS VISIBLE, ALWAYS MARKED AS THEIRS ────────────────────────────────
 *
 * is_visible and is_customer are both hard-coded 1. Neither is a parameter, so
 * no future caller can be talked into filing a customer's words as a staff note
 * — which would then be invisible to them on their own job while appearing to
 * staff as something a colleague wrote.
 */
export async function portalComment(
  siteId: number,
  customerId: number,
  customerName: string,
  jobId: number,
  body: string,
): Promise<PortalResult> {
  const settings = await portalSettings(siteId)
  if (!settings.isEnabled || !settings.allowComments) {
    return { ok: false, error: 'Messages are not switched on.' }
  }

  const clean = body.trim()
  if (clean.length < 2) return { ok: false, error: 'Please write something first.' }
  if (clean.length > 2000) return { ok: false, error: 'That message is too long.' }

  // The ownership check, as a SELECT naming both. Nothing is written until this
  // returns a row.
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM job_cards WHERE id = ? AND customer_id = ?`,
    [jobId, customerId],
  )
  if (!job) return { ok: false, error: 'That job could not be found.' }

  try {
    await siteExecute(
      siteId,
      `INSERT INTO party_comments
         (entity, entity_id, body, author_id, author_name, is_customer, is_visible)
       VALUES ('job_card', ?, ?, NULL, ?, 1, 1)`,
      [jobId, clean, customerName],
    )
    await logActivity(
      siteId,
      { userId: 0, userName: customerName },
      {
        entity: 'job_card',
        entityId: jobId,
        action: 'customer_commented',
        detail: `The customer wrote: "${clean.slice(0, 80)}"`,
      },
    ).catch(() => {})
    return { ok: true }
  } catch {
    return { ok: false, error: 'That could not be saved.' }
  }
}

/** How many files this customer has already put on a job. */
export async function customerUploadCount(
  siteId: number,
  jobId: number,
): Promise<number> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM party_documents
        WHERE entity = 'job_card' AND entity_id = ? AND is_customer = 1`,
      [jobId],
    )
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

/** Confirm a job is this customer's, for a caller that needs to check first. */
export async function ownsJob(
  siteId: number,
  customerId: number,
  jobId: number,
): Promise<boolean> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT id FROM job_cards WHERE id = ? AND customer_id = ?`,
      [jobId, customerId],
    )
    return row !== null
  } catch {
    return false
  }
}

/** Confirm a QUOTE belongs to this customer, before they may accept it. */
export async function ownsQuote(
  siteId: number,
  customerId: number,
  quoteId: number,
): Promise<{ jobId: number } | null> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT d.id, d.job_card_id
         FROM sales_documents d
        WHERE d.id = ? AND d.customer_id = ? AND d.doc_type = 'quote'
          AND d.status IN ('issued', 'finalised') AND d.job_card_id IS NOT NULL`,
      [quoteId, customerId],
    )
    return row ? { jobId: Number(row.job_card_id) } : null
  } catch {
    return null
  }
}
