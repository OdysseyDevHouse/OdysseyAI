import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { customerQueryOne } from './customerDb'
import { logActivity, type Actor } from './activityLog'
import { getSetting } from './settings'
import { saveJobCard } from './jobCards'

/**
 * Work requested from outside the business.
 *
 * ── NOTHING HERE CREATES A JOB OR A CUSTOMER ───────────────────────────────
 *
 * submitRequest writes ONE row to job_requests and touches nothing else. No job
 * card, no customer, no service address, no sequence number. A stranger with the
 * URL can fill this table and affect no figure anybody reads.
 *
 * acceptRequest is the other half, and it is the only path from here into the
 * job list. It takes an Actor, is guarded on jobs.edit, and requires a person to
 * have chosen the customer.
 *
 * ── WHAT GUARDS THE PUBLIC DOOR ────────────────────────────────────────────
 *
 * Three things, all copied from reservations because they are the only
 * anti-abuse measures this codebase has ever had and they are proven here:
 *
 *   a honeypot field, answered with a FAKE SUCCESS so a bot learns nothing
 *   a per-phone daily cap
 *   the switch, which fails closed
 *
 * There is deliberately no IP block and no captcha. The repo has neither, and
 * building a general rate limiter inside a job-cards feature would be a platform
 * decision made in the wrong place. The real protection is that a submission is
 * inert until a human accepts it.
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

export type RequestStatus = 'new' | 'accepted' | 'rejected' | 'spam'

export type JobRequest = {
  id: number
  reference: string | null
  contactName: string
  contactPhone: string
  contactEmail: string | null
  title: string
  description: string | null
  addressText: string | null
  headlineId: number | null
  headlineName: string | null
  status: RequestStatus
  jobCardId: number | null
  customerId: number | null
  createdAt: string | null
  decidedAt: string | null
  decidedByName: string | null
  decidedReason: string | null
  submittedIp: string | null
}

export type IntakeSettings = {
  isEnabled: boolean
  blurb: string
  maxPerPhonePerDay: number
  showHeadlines: boolean
}

export type SubmitResult =
  | { ok: true; reference: string }
  | { ok: false; error: string }
export type RequestActionResult = { ok: true } | { ok: false; error: string }
export type AcceptResult = { ok: true; jobId: number } | { ok: false; error: string }

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Digits only — how two phone numbers are compared for the cap. */
function phoneKey(phone: string): string {
  return phone.replace(/\D/g, '')
}

function mapRequest(r: Row): JobRequest {
  return {
    id: Number(r.id),
    reference: text(r.reference),
    contactName: String(r.contact_name ?? ''),
    contactPhone: String(r.contact_phone ?? ''),
    contactEmail: text(r.contact_email),
    title: String(r.title ?? ''),
    description: text(r.description),
    addressText: text(r.address_text),
    headlineId: r.headline_id === null ? null : Number(r.headline_id),
    headlineName: text(r.headline_name),
    status: String(r.status) as RequestStatus,
    jobCardId: r.job_card_id === null ? null : Number(r.job_card_id),
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    createdAt: wallClock(r.created_at),
    decidedAt: wallClock(r.decided_at),
    decidedByName: text(r.decided_by_name),
    decidedReason: text(r.decided_reason),
    submittedIp: text(r.submitted_ip),
  }
}

/** How the public form is configured. Fails CLOSED on any error. */
export async function intakeSettings(siteId: number): Promise<IntakeSettings> {
  const closed: IntakeSettings = {
    isEnabled: false,
    blurb: '',
    maxPerPhonePerDay: 3,
    showHeadlines: true,
  }
  try {
    const [enabled, blurb, cap, headlines] = await Promise.all([
      getSetting(siteId, 'job_intake_enabled'),
      getSetting(siteId, 'job_intake_blurb'),
      getSetting(siteId, 'job_intake_max_per_phone'),
      getSetting(siteId, 'job_intake_show_headlines'),
    ])
    return {
      isEnabled: enabled === '1',
      blurb,
      maxPerPhonePerDay: Math.max(0, Math.min(100, Number(cap) || 0)),
      showHeadlines: headlines === '1',
    }
  } catch {
    // A site without 129 has no public form, which is the safe answer.
    return closed
  }
}

/**
 * Take a request from the public form.
 *
 * ── NO ACTOR, BECAUSE THERE IS NO USER ─────────────────────────────────────
 *
 * Whoever is filling this in is a stranger. Nothing here is logged to
 * activity_log for that reason: an audit trail entry with no actor behind it
 * says less than the row itself does.
 */
export async function submitRequest(
  siteId: number,
  input: {
    contactName: string
    contactPhone: string
    contactEmail: string | null
    title: string
    description: string | null
    addressText: string | null
    headlineId: number | null
    /** The hidden field. Anything in it means a bot filled the form. */
    honeypot?: string | null
    ip?: string | null
  },
): Promise<SubmitResult> {
  /*
   * The honeypot, answered with a FAKE SUCCESS.
   *
   * Nothing is written and a plausible reference is returned. Telling a bot it
   * failed teaches it to try again differently; telling it that it succeeded
   * ends the conversation. Straight from reservations, which returns a
   * fabricated id for the same reason.
   */
  if (text(input.honeypot)) {
    return { ok: true, reference: 'REQ-' + String(Date.now()).slice(-6) }
  }

  const settings = await intakeSettings(siteId)
  // Re-checked here and not only on the page: a server action is a public HTTP
  // endpoint, and the page's check protected the page.
  if (!settings.isEnabled) {
    return { ok: false, error: 'This form is not accepting requests at the moment.' }
  }

  const name = input.contactName.trim()
  if (name.length < 2) return { ok: false, error: 'Please give your name.' }
  if (name.length > 120) return { ok: false, error: 'That name is too long.' }

  const phone = input.contactPhone.trim()
  if (phoneKey(phone).length < 7) return { ok: false, error: 'Please give a phone number.' }
  if (phone.length > 40) return { ok: false, error: 'That phone number is too long.' }

  const email = text(input.contactEmail)
  if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: 'That email address does not look right.' }
  }

  const title = input.title.trim()
  if (title.length < 3) return { ok: false, error: 'Please say what you need done.' }
  if (title.length > 190) return { ok: false, error: 'Please keep the summary shorter.' }

  /*
   * The headline is checked against the ACTIVE list rather than trusted.
   *
   * The form offers a dropdown; the action receives an integer from a stranger.
   * Without this, somebody could attach a request to a retired kind of work, or
   * to a headline id that means something else entirely.
   */
  let headlineId: number | null = null
  if (input.headlineId !== null && settings.showHeadlines) {
    const found = await siteQueryOne<Row>(
      siteId,
      `SELECT id FROM job_headlines WHERE id = ? AND is_active = 1`,
      [input.headlineId],
    ).catch(() => null)
    headlineId = found ? Number(found.id) : null
  }

  // The daily cap. A counting query, exactly as reservations does it.
  if (settings.maxPerPhonePerDay > 0) {
    const digits = phoneKey(phone)
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM job_requests
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(contact_phone, ' ', ''), '-', ''), '(', ''), ')', '') = ?
          AND created_at >= CURDATE()
          AND status <> 'spam'`,
      [digits],
    )
    if (Number(row?.n ?? 0) >= settings.maxPerPhonePerDay) {
      return {
        ok: false,
        error: 'You have already sent us a few requests today. Please phone us instead.',
      }
    }
  }

  try {
    const reference = await siteTransaction(siteId, async (tx) => {
      const [res] = await tx.execute<import('mysql2/promise').ResultSetHeader>(
        `INSERT INTO job_requests
           (contact_name, contact_phone, contact_email, title, description,
            address_text, headline_id, submitted_ip)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          name,
          phone,
          email,
          title,
          text(input.description)?.slice(0, 4000) ?? null,
          text(input.addressText)?.slice(0, 400) ?? null,
          headlineId,
          text(input.ip)?.slice(0, 45) ?? null,
        ],
      )
      const id = Number(res.insertId)
      // Derived from the id, as reservations does: no sequence is burned on a
      // request that will probably be rejected.
      const ref = `REQ-${String(id).padStart(5, '0')}`
      await tx.execute(`UPDATE job_requests SET reference = ? WHERE id = ?`, [ref, id])
      return ref
    })
    return { ok: true, reference }
  } catch {
    return { ok: false, error: 'That could not be sent. Please try again, or phone us.' }
  }
}

const SELECT = `
  SELECT r.*, h.name AS headline_name
    FROM job_requests r
    LEFT JOIN job_headlines h ON h.id = r.headline_id`

export async function listRequests(
  siteId: number,
  status: RequestStatus | 'all' = 'new',
): Promise<JobRequest[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `${SELECT}
        ${status === 'all' ? '' : 'WHERE r.status = ?'}
        ORDER BY r.created_at DESC LIMIT 300`,
      status === 'all' ? [] : [status],
    )
    return rows.map(mapRequest)
  } catch {
    return []
  }
}

export async function getRequest(siteId: number, id: number): Promise<JobRequest | null> {
  try {
    const row = await siteQueryOne<Row>(siteId, `${SELECT} WHERE r.id = ? LIMIT 1`, [id])
    return row ? mapRequest(row) : null
  } catch {
    return null
  }
}

/** How many are waiting. For the badge on the nav and the list screen. */
export async function newRequestCount(siteId: number): Promise<number> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM job_requests WHERE status = 'new'`,
    )
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

/**
 * Turn a request into a job.
 *
 * ── THE CUSTOMER IS CHOSEN BY A PERSON, ALWAYS ─────────────────────────────
 *
 * customerId is a required argument, and there is no path that derives one from
 * the submitted text. Matching "J Smith, 082..." to an account is a judgement —
 * two customers share a surname, a phone number moves house — and getting it
 * wrong files somebody's work against a stranger's account.
 *
 * Creating a NEW customer is also a deliberate act, done on the customers screen
 * before accepting. This function will not do it.
 */
export async function acceptRequest(
  siteId: number,
  actor: Actor,
  requestId: number,
  customerId: number,
  overrides: { title?: string; description?: string | null } = {},
): Promise<AcceptResult> {
  const request = await getRequest(siteId, requestId)
  if (!request) return { ok: false, error: 'That request no longer exists.' }
  if (request.status !== 'new') {
    return { ok: false, error: `This request was already ${request.status}.` }
  }
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return { ok: false, error: 'Choose which customer this is for.' }
  }

  const customer = await customerQueryOne<Row>(
    siteId,
    `SELECT id, name FROM customers WHERE id = ?`,
    [customerId],
  )
  if (!customer) return { ok: false, error: 'That customer no longer exists.' }

  /*
   * The job goes through saveJobCard, not a direct INSERT.
   *
   * The same argument applyTeamToJob makes about setJobPerson: that door
   * validates, allocates the number, snapshots the customer and writes the audit
   * trail, and a job created around it would be subtly unlike every other job.
   */
  const job = await saveJobCard(siteId, actor, {
    id: null,
    customerId,
    customerName: null,
    customerPhone: request.contactPhone,
    customerEmail: request.contactEmail,
    serviceAddressId: null,
    locationId: null,
    statusId: null,
    priority: 'normal',
    ownerUserId: null,
    ownerName: '',
    title: overrides.title?.trim() || request.title,
    description: buildDescription(request, overrides.description),
    dueAt: null,
    // The reserved enum value, finally used. Reporting can now answer "how much
    // work arrives through the website".
    source: 'public_form',
    reference: request.reference,
    internalNote: null,
  })
  if (!job.ok) return { ok: false, error: job.error }

  await siteExecute(
    siteId,
    `UPDATE job_requests
        SET status = 'accepted', job_card_id = ?, customer_id = ?,
            decided_at = NOW(), decided_by_user_id = ?, decided_by_name = ?
      WHERE id = ?`,
    [job.id, customerId, actor.userId, actor.userName, requestId],
  )

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: job.id,
    action: 'raised_from_request',
    detail: `Raised from public request ${request.reference ?? requestId} by ${request.contactName}`,
  }).catch(() => {})

  return { ok: true, jobId: job.id }
}

/**
 * What the customer typed, kept on the job.
 *
 * Their own words matter: "it makes a grinding noise on start-up" is the useful
 * part, and a job that dropped it in favour of a tidy title loses the only
 * first-hand account of the fault.
 */
function buildDescription(request: JobRequest, override: string | null | undefined): string | null {
  if (override !== undefined && override !== null) return override.trim() || null
  const parts: string[] = []
  if (request.description) parts.push(request.description)
  if (request.addressText) parts.push(`Address given: ${request.addressText}`)
  parts.push(`Requested by ${request.contactName} (${request.contactPhone})`)
  return parts.join('\n\n')
}

/** Turn one down, or mark it as junk. */
export async function rejectRequest(
  siteId: number,
  actor: Actor,
  requestId: number,
  status: 'rejected' | 'spam',
  reason: string | null,
): Promise<RequestActionResult> {
  const request = await getRequest(siteId, requestId)
  if (!request) return { ok: false, error: 'That request no longer exists.' }
  if (request.status === 'accepted') {
    return { ok: false, error: 'This one already became a job. Cancel the job instead.' }
  }

  await siteExecute(
    siteId,
    `UPDATE job_requests
        SET status = ?, decided_at = NOW(), decided_by_user_id = ?, decided_by_name = ?,
            decided_reason = ?
      WHERE id = ?`,
    [status, actor.userId, actor.userName, text(reason)?.slice(0, 400) ?? null, requestId],
  )
  return { ok: true }
}

/** Put a rejected one back in the queue. Everybody turns something down by mistake. */
export async function reopenRequest(
  siteId: number,
  actor: Actor,
  requestId: number,
): Promise<RequestActionResult> {
  const request = await getRequest(siteId, requestId)
  if (!request) return { ok: false, error: 'That request no longer exists.' }
  if (request.status === 'accepted') {
    return { ok: false, error: 'This one already became a job.' }
  }
  await siteExecute(
    siteId,
    `UPDATE job_requests
        SET status = 'new', decided_at = NULL, decided_by_user_id = NULL,
            decided_by_name = NULL, decided_reason = NULL
      WHERE id = ?`,
    [requestId],
  )
  return { ok: true }
}

export type IntakeDrift = {
  /** Sitting in the queue with nobody looking. A request is somebody waiting. */
  stale: { id: number; reference: string | null; contactName: string; createdAt: string | null }[]
  /** Accepted, but the job it made is gone. */
  orphaned: { id: number; reference: string | null; jobCardId: number | null }[]
}

/** Reports, never repairs. */
export async function reconcileJobIntake(siteId: number): Promise<IntakeDrift> {
  const empty: IntakeDrift = { stale: [], orphaned: [] }
  try {
    const staleRows = await siteQuery<Row>(
      siteId,
      `SELECT id, reference, contact_name, created_at
         FROM job_requests
        WHERE status = 'new' AND created_at < DATE_SUB(NOW(), INTERVAL 3 DAY)
        ORDER BY created_at LIMIT 200`,
    )
    /*
     * Accepted with no job.
     *
     * The FK is SET NULL, so deleting the job blanks the link rather than the
     * row. That is deliberate — the request is evidence somebody asked — but it
     * leaves a request claiming to have become a job that no longer exists.
     */
    const orphanRows = await siteQuery<Row>(
      siteId,
      `SELECT id, reference, job_card_id FROM job_requests
        WHERE status = 'accepted' AND job_card_id IS NULL LIMIT 200`,
    )
    return {
      stale: staleRows.map((r) => ({
        id: Number(r.id),
        reference: text(r.reference),
        contactName: String(r.contact_name ?? ''),
        createdAt: wallClock(r.created_at),
      })),
      orphaned: orphanRows.map((r) => ({
        id: Number(r.id),
        reference: text(r.reference),
        jobCardId: r.job_card_id === null ? null : Number(r.job_card_id),
      })),
    }
  } catch {
    return empty
  }
}
