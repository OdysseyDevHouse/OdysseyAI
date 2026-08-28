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
 *   forms not marked public, and   is_public defaults to 0 there too, and a
 *   forms not yet SUBMITTED        draft is a technician's working notes
 *   form answers that are files,   a file id is a key to something the files
 *   coordinates or record ids      rule above gates; a GPS reading is where a
 *                                  technician stood, which is staffing data
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

/**
 * Flat answer rows into one entry per form (222).
 *
 * The query returns a row per FIELD, because that is the only way to get the
 * fields and their answers in one round trip. Grouped here rather than by
 * issuing a query per form, which on a job with four reports would be five.
 *
 * An UNANSWERED field is dropped rather than shown blank. A customer reading a
 * commissioning report does not need a list of questions nobody filled in — and
 * a conditional field that was never asked would otherwise appear as an
 * unanswered one, which reads as an omission rather than an irrelevance.
 */
function groupForms(rows: Row[]): PortalJobDetail['forms'] {
  const byResponse = new Map<number, PortalJobDetail['forms'][number]>()

  for (const r of rows) {
    const id = Number(r.response_id)
    let entry = byResponse.get(id)
    if (!entry) {
      entry = {
        id,
        name: String(r.form_name ?? ''),
        submittedAt: wallClock(r.submitted_at),
        answers: [],
      }
      byResponse.set(id, entry)
    }

    const type = String(r.field_type)
    if (type === 'heading') {
      entry.answers.push({ label: String(r.label ?? ''), value: '', isHeading: true })
      continue
    }

    /*
     * One value out of four typed columns, in the order the model stores them.
     * A boolean reads as Yes or No rather than 1 or 0 — a customer report
     * saying "Isolator locked off: 1" is a report nobody can read.
     */
    let value: string | null = null
    if (r.value_bool !== null && r.value_bool !== undefined) {
      value = Number(r.value_bool) === 1 ? 'Yes' : 'No'
    } else if (r.value_number !== null && r.value_number !== undefined) {
      value = `${Number(r.value_number)}${r.unit ? ` ${String(r.unit)}` : ''}`
    } else if (r.value_date !== null && r.value_date !== undefined) {
      value = wallClock(r.value_date)
    } else if (r.value_text !== null && r.value_text !== undefined) {
      value = String(r.value_text)
    }

    if (value === null || value.trim() === '') continue
    entry.answers.push({ label: String(r.label ?? ''), value, isHeading: false })
  }

  /*
   * A form whose every answer was dropped shows nothing at all. Publishing an
   * empty report would say "we did this and recorded nothing", which is worse
   * than not mentioning it.
   */
  return [...byResponse.values()].filter((f) => f.answers.some((a) => !a.isHeading))
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
  /**
   * Submitted forms the business marked public, with their answers.
   *
   * Both halves are required: `is_public` on the form and `submitted_at` on the
   * response. A draft is a technician's working notes — readings still being
   * taken — and publishing one would show a customer figures nobody has stood
   * behind yet.
   *
   * Answers are TEXT ONLY. A file id would hand out a key to something the
   * files rule above deliberately gates, and a GPS reading says where a
   * technician was standing, which is staffing information.
   */
  forms: {
    id: number
    name: string
    submittedAt: string | null
    answers: { label: string; value: string; isHeading: boolean }[]
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

    const [visits, comments, files, extras, quotes, formRows] = await Promise.all([
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
      /*
       * Forms a customer may see, and only those (222).
       *
       * FOUR conditions, and every one of them is load-bearing:
       *
       *   f.is_public = 1        the flag defaults to 0, so a form is internal
       *                          until somebody deliberately shares it — the
       *                          same stance custom fields take
       *   submitted_at NOT NULL  a half-filled draft is a technician's working
       *                          notes, not a report. Publishing one would show
       *                          a customer readings that are still being taken
       *   r.job_card_id = ?      this job, which the outer WHERE already proved
       *                          belongs to this customer
       *   fields joined by the RESPONSE'S OWN VERSION, not the live one — the
       *   customer sees the questions that were actually asked, which is the
       *   whole point of versioning
       *
       * Answers come back as text only. No attachment_id, no record_id, no
       * coordinates: publishing a file id would hand out a key to something the
       * files rule above deliberately gates, and a GPS reading is where a
       * TECHNICIAN was standing, which is staffing information.
       */
      siteQuery<Row>(
        siteId,
        `SELECT r.id AS response_id, f.name AS form_name, r.submitted_at,
                fl.id AS field_id, fl.label, fl.field_type, fl.unit, fl.sort_order,
                a.value_text, a.value_number, a.value_date, a.value_bool
           FROM job_form_responses r
           JOIN job_forms f        ON f.id = r.form_id AND f.is_public = 1
           JOIN job_form_fields fl ON fl.version_id = r.version_id
           LEFT JOIN job_form_answers a ON a.response_id = r.id AND a.field_id = fl.id
          WHERE r.job_card_id = ?
            AND r.submitted_at IS NOT NULL
            AND fl.field_type NOT IN ('page_break')
          ORDER BY r.submitted_at DESC, r.id, fl.sort_order, fl.id`,
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
      forms: groupForms(formRows),
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

/**
 * A link to pay one invoice, for a customer who owns it.
 *
 * ── IT REUSES /pay, IT DOES NOT REBUILD IT ─────────────────────────────────
 *
 * The portal mints a payment INTENT and hands off to the flow that already
 * exists. Everything downstream — the gateway form, the callback, the receipt,
 * the settlement onto the customer account — is untouched, which is the whole
 * point: a second payment path is a second place for money to go wrong.
 *
 * ── OWNERSHIP IS CHECKED BEFORE AN INTENT EXISTS ───────────────────────────
 *
 * The SELECT names the customer, so an invoice belonging to somebody else never
 * reaches createIntent. An intent is a claim on money; minting one for a
 * stranger's invoice would put a real payment against a real account.
 */
export async function payLinkFor(
  siteId: number,
  customerId: number,
  documentId: number,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const invoice = await siteQueryOne<Row>(
    siteId,
    `SELECT d.id, d.total_incl, COALESCE(t.amount_outstanding, 0) AS outstanding
       FROM sales_documents d
       LEFT JOIN customer_transactions t
              ON t.source = 'sale' AND t.source_doc_id = d.id
      WHERE d.id = ? AND d.customer_id = ?
        AND d.doc_type = 'invoice' AND d.status = 'finalised'`,
    [documentId, customerId],
  ).catch(() => null)
  if (!invoice) return { ok: false, error: 'That invoice could not be found.' }

  const outstanding = Number(invoice.outstanding ?? 0)
  if (outstanding <= 0) return { ok: false, error: 'That invoice is already settled.' }

  try {
    const { createIntent } = await import('./payments')
    const { createCallbackToken } = await import('../callbackToken')
    const intent = await createIntent(siteId, {
      // The purpose 038_payments.sql already anticipated for exactly this.
      target: { purpose: 'debtor_invoice', documentId },
      amountIncl: outstanding,
    })
    const token = await createCallbackToken(siteId, intent.reference)
    return { ok: true, url: `/pay/${token}` }
  } catch {
    return { ok: false, error: 'Paying online is not available at the moment.' }
  }
}

/**
 * A customer attaches a photo to their own job.
 *
 * ── IT IS NARROWER THAN THE APP-WIDE ALLOWLIST ─────────────────────────────
 *
 * storeUpload accepts PDF, images, Office documents, text, email and ZIP —
 * right for a staff member attaching a supplier invoice, too wide for a form
 * anybody on the internet can reach. A public path takes PICTURES and PDFs,
 * which is what "here is a photo of the leak" needs and nothing more.
 *
 * The count cap is per job and configurable; the size cap is storeUpload's own
 * 10MB, which it re-checks after buffering because File.size is a claim.
 */
const PORTAL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.pdf'])

export async function portalUpload(
  siteId: number,
  customerId: number,
  customerName: string,
  jobId: number,
  file: File,
): Promise<PortalResult> {
  const settings = await portalSettings(siteId)
  if (!settings.isEnabled || !settings.allowUploads) {
    return { ok: false, error: 'Sending files is not switched on.' }
  }

  // Ownership before anything touches the disk.
  if (!(await ownsJob(siteId, customerId, jobId))) {
    return { ok: false, error: 'That job could not be found.' }
  }

  const already = await customerUploadCount(siteId, jobId)
  if (settings.maxUploadsPerJob > 0 && already >= settings.maxUploadsPerJob) {
    return {
      ok: false,
      error: `You have already sent ${already} files for this job. Please phone the business.`,
    }
  }

  const name = (file?.name ?? '').toLowerCase()
  const ext = name.slice(name.lastIndexOf('.'))
  if (!PORTAL_EXTENSIONS.has(ext)) {
    return { ok: false, error: 'Please send a photo or a PDF.' }
  }

  const { storeUpload } = await import('../uploads')
  const stored = await storeUpload(file)
  if (!stored.ok) return { ok: false, error: stored.error }

  try {
    await siteExecute(
      siteId,
      `INSERT INTO party_documents
         (entity, entity_id, filename, stored_name, mime_type, size_bytes,
          uploaded_by, uploaded_name, is_customer, is_visible)
       VALUES ('job_card', ?, ?, ?, ?, ?, NULL, ?, 1, 1)`,
      [
        jobId,
        stored.file.filename,
        stored.file.storedName,
        stored.file.mimeType,
        stored.file.sizeBytes,
        customerName,
      ],
    )
    await logActivity(
      siteId,
      { userId: 0, userName: customerName },
      {
        entity: 'job_card',
        entityId: jobId,
        action: 'customer_uploaded',
        detail: `The customer sent ${stored.file.filename}`,
      },
    ).catch(() => {})
    return { ok: true }
  } catch {
    return { ok: false, error: 'That could not be saved.' }
  }
}

/* ── The account side: profile, transactions, statement ──────────────────── */

/**
 * The customer's own details, as THEY may see them.
 *
 * ── A HAND-WRITTEN COLUMN LIST, NOT `getCustomer` ──────────────────────────
 *
 * getCustomer returns the whole row, and the whole row is not a document a
 * customer may read. It carries the sales rep, the notes staff wrote about
 * them, the standing discount, the interest rate and grace days, the price
 * structure and the spend caps — commercial terms the business set, some of
 * which are frankly uncomfortable reading, and none of which a shopper asked
 * for. Passing that object to a page and picking fields in JSX would put every
 * one of them in the HTML payload regardless of what was rendered.
 *
 * So the SELECT is the boundary, exactly as the module header says. What is not
 * named here cannot reach a browser by being forgotten in a component.
 *
 * ── READ-ONLY, AND THAT IS THE POINT ───────────────────────────────────────
 *
 * There is no matching write. A customer correcting their own VAT number or
 * address on a live debtors account changes what gets invoiced and where it
 * gets delivered, without anybody at the shop knowing. They ring up instead,
 * which is a worse UX and a much better control.
 */
export type PortalProfile = {
  code: string
  name: string
  contactName: string | null
  email: string | null
  phone: string | null
  vatNumber: string | null
  addressLines: string[]
  /** Days from invoice to due. Shown because it explains every due date. */
  paymentTermsDays: number
  /** What they owe right now. Positive means owing. */
  balance: number
}

export async function portalProfile(
  siteId: number,
  customerId: number,
): Promise<PortalProfile | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT code, name, contact_name, email, phone, vat_number,
            address_line1, address_line2, city, postal_code,
            payment_terms_days, balance
       FROM customers
      WHERE id = ?`,
    [customerId],
  )
  if (!row) return null

  return {
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    contactName: (row.contact_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    vatNumber: (row.vat_number as string | null) ?? null,
    // Assembled here rather than in the page: the same four columns are laid
    // out on the statement PDF too, and two places deciding what an address
    // looks like is how they come to disagree.
    addressLines: [row.address_line1, row.address_line2, row.city, row.postal_code]
      .map((part) => String(part ?? '').trim())
      .filter((part) => part.length > 0),
    paymentTermsDays: Number(row.payment_terms_days ?? 0),
    balance: Number(row.balance ?? 0),
  }
}

/**
 * Where a customer may deliver to. Their own, active ones only.
 *
 * Shown on the profile beside the account address because "which of my
 * addresses do you have" is one of the questions this page exists to answer.
 */
export type PortalAddress = {
  id: number
  kind: string
  label: string
  lines: string[]
  isDefault: boolean
}

export async function portalAddresses(
  siteId: number,
  customerId: number,
): Promise<PortalAddress[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, kind, label, line1, line2, city, postal_code, province, is_default
       FROM customer_addresses
      WHERE customer_id = ? AND is_active = 1
      ORDER BY kind, is_default DESC, sort_order, label`,
    [customerId],
  )
  // `notes` is deliberately not selected: an address note is a message to the
  // DRIVER — gate codes, "ring twice", "dog in the yard" — written by staff.
  return rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    label: String(r.label ?? ''),
    lines: [r.line1, r.line2, r.city, r.province, r.postal_code]
      .map((part) => String(part ?? '').trim())
      .filter((part) => part.length > 0),
    isDefault: !!r.is_default,
  }))
}
