import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import { getSetting } from './settings'
import { notify } from './notifications'
import { setStatus } from './jobCards'
import { statusForRole } from './jobStatuses'

/**
 * Asking for a part the shop does not have (§28).
 *
 * ── THE DEAD END THIS REPLACES ─────────────────────────────────────────────
 *
 * A technician who needs a part that is not on the shelf gets this, from
 * stockTransfers.ts by way of issueParts:
 *
 *   "BRK-PAD-01 has only 0 in Main Store — cannot move 4."
 *
 * True, and there is nowhere to go from it. This module is the onward path:
 * ask, a buyer decides, purchasing raises a real order, and the goods arriving
 * tells the person who asked.
 *
 * ── THREE RULES THAT KEEP THIS SAFE ────────────────────────────────────────
 *
 * 1. THE JOB MODULE RAISES NO PURCHASE ORDER AND WRITES NO STOCK MOVEMENT.
 *    It records a request and reads what purchasing did. `linkToOrder` below
 *    takes a purchase line id that somebody else created; nothing here calls
 *    saveOrder, and nothing here calls recordMovement. This is the same
 *    discipline that kept finaliseDocument() the only posting engine.
 *
 * 2. A REQUEST RESERVES NOTHING. jobParts.ts:23-41 records that a job
 *    reservation folded into reservedQtyFor() was designed and deliberately
 *    dropped, because availableToSell() subtracts a site-wide reservation from
 *    the MAIN pile which has already dropped by the transfer — so the same unit
 *    is deducted twice, for every part in every van, permanently. A part that
 *    does not exist yet must certainly not reserve anything.
 *
 * 3. A REQUEST IS NOT A DOCUMENT. No sequence number is burned on something
 *    usually declined — the doctrine job_requests (129) already set.
 *
 * ── WHAT IS OUT OF SCOPE, SAID PLAINLY ─────────────────────────────────────
 *
 * Partial receipts, substitutions and backorders. A request moves to `received`
 * when the purchase line it is on has received anything at all. Splitting one
 * request across two deliveries is a real thing that happens; it is not built
 * here, and pretending otherwise by silently marking a half-delivered request
 * complete is the honest failure to name rather than hide.
 */

type Row = RowDataPacket & Record<string, unknown>

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/** The same helper as jobAppointments — see its header for why getUTC*. */
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

export const REQUEST_STATUSES = [
  'requested',
  'approved',
  'ordered',
  'received',
  'cancelled',
] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  requested: 'Asked for',
  approved: 'Approved',
  ordered: 'On order',
  received: 'Arrived',
  cancelled: 'Declined',
}

/** Which states still count as outstanding on a job. */
const OPEN_STATUSES: RequestStatus[] = ['requested', 'approved', 'ordered']

export type PartRequest = {
  id: number
  jobCardId: number
  jobNumber: string | null
  jobTitle: string
  jobCardLineId: number | null
  productId: number | null
  productCode: string | null
  description: string
  qty: number
  status: RequestStatus
  statusLabel: string
  reason: string | null
  requestedByName: string
  requestedByUserId: number | null
  decidedByName: string | null
  decidedAt: string | null
  decidedNote: string | null
  purchaseLineId: number | null
  /** The order it landed on, once a buyer raised one. */
  purchaseDocId: number | null
  purchaseNumber: string | null
  createdAt: string | null
}

export type RequestResult = { ok: true; id: number } | { ok: false; error: string }
export type RequestActionResult = { ok: true } | { ok: false; error: string }

const SELECT_REQUEST = `
  SELECT r.id, r.job_card_id, r.job_card_line_id, r.product_id, r.product_code,
         r.description, r.qty, r.status, r.reason,
         r.requested_by_user_id, r.requested_by_name,
         r.decided_by_user_id, r.decided_by_name, r.decided_at, r.decided_note,
         r.purchase_line_id, r.created_at,
         j.document_number AS job_number, j.title AS job_title,
         pl.document_id AS purchase_doc_id,
         pd.document_number AS purchase_number
    FROM job_part_requests r
    JOIN job_cards j ON j.id = r.job_card_id
    LEFT JOIN purchase_document_lines pl ON pl.id = r.purchase_line_id
    LEFT JOIN purchase_documents pd      ON pd.id = pl.document_id`

function mapRequest(r: Row): PartRequest {
  const status = String(r.status) as RequestStatus
  return {
    id: Number(r.id),
    jobCardId: Number(r.job_card_id),
    jobNumber: text(r.job_number),
    jobTitle: String(r.job_title),
    jobCardLineId: r.job_card_line_id === null ? null : Number(r.job_card_line_id),
    productId: r.product_id === null ? null : Number(r.product_id),
    productCode: text(r.product_code),
    description: String(r.description),
    qty: Number(r.qty),
    status,
    statusLabel: REQUEST_STATUS_LABEL[status] ?? status,
    reason: text(r.reason),
    requestedByName: String(r.requested_by_name ?? ''),
    requestedByUserId: r.requested_by_user_id === null ? null : Number(r.requested_by_user_id),
    decidedByName: text(r.decided_by_name),
    decidedAt: wallClock(r.decided_at),
    decidedNote: text(r.decided_note),
    purchaseLineId: r.purchase_line_id === null ? null : Number(r.purchase_line_id),
    purchaseDocId: r.purchase_doc_id === null ? null : Number(r.purchase_doc_id),
    purchaseNumber: text(r.purchase_number),
    createdAt: wallClock(r.created_at),
  }
}

export async function requestsEnabled(siteId: number): Promise<boolean> {
  const raw = await getSetting(siteId, 'job_part_requests_enabled').catch(() => '1')
  return String(raw ?? '1') !== '0'
}

/** What this job is waiting on. Tolerant of a site without 162. */
export async function requestsForJob(siteId: number, jobId: number): Promise<PartRequest[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_REQUEST} WHERE r.job_card_id = ? ORDER BY r.created_at DESC, r.id DESC`,
    [jobId],
  ).catch(() => [])
  return rows.map(mapRequest)
}

/**
 * The buyer's queue.
 *
 * Defaults to what still needs doing, because a queue showing every request
 * ever made is a list nobody opens twice.
 */
export async function requestQueue(
  siteId: number,
  opts: { statuses?: RequestStatus[]; limit?: number } = {},
): Promise<PartRequest[]> {
  const statuses = opts.statuses?.length ? opts.statuses : OPEN_STATUSES
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200)))
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_REQUEST}
      WHERE r.status IN (${statuses.map(() => '?').join(',')})
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT ${limit}`,
    statuses,
  ).catch(() => [])
  return rows.map(mapRequest)
}

export type PartRequestInput = {
  jobCardId: number
  jobCardLineId?: number | null
  productId?: number | null
  productCode?: string | null
  description: string
  qty: number
  reason?: string | null
}

/**
 * Ask for a part.
 *
 * Deliberately permissive about WHAT is asked for: `product_id` may be null, so
 * a technician can ask for something not on file at all. §28 wants that, and it
 * is how a one-off part gets bought — refusing anything without a product code
 * would send people back to a phone call, which is the behaviour this replaces.
 */
export async function requestPart(
  siteId: number,
  actor: Actor,
  input: PartRequestInput,
): Promise<RequestResult> {
  if (!(await requestsEnabled(siteId))) {
    return { ok: false, error: 'Asking for parts has been switched off for this business.' }
  }
  const description = input.description.trim()
  if (!description) return { ok: false, error: 'Say what is needed.' }
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    return { ok: false, error: 'How many are needed?' }
  }

  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, document_number, title FROM job_cards WHERE id = ?`,
    [input.jobCardId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so parts cannot be requested for it.' }
  }

  const res = await siteExecute(
    siteId,
    `INSERT INTO job_part_requests
       (job_card_id, job_card_line_id, product_id, product_code, description, qty,
        status, reason, requested_by_user_id, requested_by_name)
     VALUES (?,?,?,?,?,?, 'requested', ?,?,?)`,
    [
      input.jobCardId,
      input.jobCardLineId ?? null,
      input.productId ?? null,
      input.productCode?.slice(0, 48) ?? null,
      description.slice(0, 190),
      input.qty,
      input.reason?.trim().slice(0, 400) || null,
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: input.jobCardId,
    action: 'part_requested',
    detail: `${input.qty} × ${description}`,
  })

  /*
   * The bell, to whoever buys. Audience-wide rather than to a named person:
   * the request has no owner until somebody picks it up, and addressing it to
   * one buyer would hide it from the one who happens to be in today.
   *
   * notify() never throws, so a failure here cannot un-record the request.
   */
  await notify(siteId, {
    event: 'job_part_requested',
    audience: 'purchasing.view',
    title: `Part needed: ${description}`,
    body: `${input.qty} for ${text(job.document_number) ?? `job #${input.jobCardId}`}${
      input.reason?.trim() ? ` — ${input.reason.trim()}` : ''
    }`,
    href: '/jobs/part-requests',
  })

  // The job is now waiting on somebody else (§28). Never fatal — see the helper.
  await moveToAwaitingParts(siteId, actor, input.jobCardId)

  return { ok: true, id: Number(res.insertId) }
}

/* ── Awaiting Parts, in and out (§28) ─────────────────────────────────────── */

/**
 * Found by CODE, not by role.
 *
 * 104 seeds this status with `role = ''` deliberately: the six required roles
 * are the lifecycle a business cannot delete its way out of, and waiting for a
 * part is not one of them — a workshop that fits only what it stocks never needs
 * the stage. So there is no `statusForRole('parts')` to call.
 *
 * `code` is the right handle regardless: jobStatuses freezes it at creation
 * precisely so a rename relabels every job sitting in the status rather than
 * stranding it. A business that renamed this to "Waiting on supplier" still has
 * code 'parts', and this still finds it.
 *
 * Null when the business deleted or deactivated the status, which is a real
 * answer and not an error — it means "this shop does not track that", and the
 * callers below simply do nothing.
 */
async function awaitingPartsStatusId(siteId: number): Promise<number | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM job_statuses WHERE code = 'parts' AND is_active = 1 LIMIT 1`,
    [],
  ).catch(() => null)
  return row ? Number(row.id) : null
}

async function autoAwaitingParts(siteId: number): Promise<boolean> {
  return (await getSetting(siteId, 'job_auto_awaiting_parts').catch(() => '1')) !== '0'
}

/**
 * Put a job into Awaiting Parts because something was asked for.
 *
 * ── WHY THIS CANNOT THROW ──────────────────────────────────────────────────
 *
 * It runs at the tail of requestPart, after the request is already written. A
 * status move that failed and took the request with it would mean a technician
 * pressing "ask for this part" and getting an error, with nothing recorded —
 * strictly worse than a job that is on the wrong stage but has its request.
 *
 * Same shape as the notify() call beside it, and the same reasoning.
 *
 * ── AND WHY IT ONLY MOVES AN OPEN JOB ──────────────────────────────────────
 *
 * setStatus would happily move a closed one, and moving a closed job back into
 * an open stage because somebody logged a late part request would reopen work
 * that was finished — silently, from a screen that never mentioned closing.
 */
async function moveToAwaitingParts(siteId: number, actor: Actor, jobId: number): Promise<void> {
  try {
    if (!(await autoAwaitingParts(siteId))) return
    const statusId = await awaitingPartsStatusId(siteId)
    if (statusId === null) return

    const job = await siteQueryOne<Row>(
      siteId,
      `SELECT status, status_id FROM job_cards WHERE id = ?`,
      [jobId],
    )
    if (!job || String(job.status) !== 'open') return
    if (Number(job.status_id) === statusId) return

    await setStatus(siteId, actor, jobId, statusId, 'Waiting for a part that was asked for.')
  } catch {
    /* Reported by nothing, and deliberately: the request is what mattered. */
  }
}

/**
 * Take a job back OUT of Awaiting Parts once nothing is outstanding.
 *
 * This is the half that makes the automation safe to have on. A stage a job
 * enters by itself and can only leave by hand is a trap — a dispatcher who finds
 * forty jobs sitting in Awaiting Parts turns the feature off rather than
 * clearing them one by one.
 *
 * "Settled" means no request on the job is still `requested`, `approved` or
 * `ordered`. A cancelled one is settled: the buyer decided it is not coming, and
 * the job is no longer waiting for it.
 *
 * Moves to `in_progress` rather than back to whatever it was before, because
 * nothing records that. A job whose parts have arrived IS work that can proceed,
 * which is what that stage means; guessing at a previous status would need a
 * history this table does not keep.
 */
export async function clearAwaitingPartsIfSettled(
  siteId: number,
  actor: Actor,
  jobId: number,
): Promise<void> {
  try {
    if (!(await autoAwaitingParts(siteId))) return
    const statusId = await awaitingPartsStatusId(siteId)
    if (statusId === null) return

    const job = await siteQueryOne<Row>(
      siteId,
      `SELECT status, status_id FROM job_cards WHERE id = ?`,
      [jobId],
    )
    // Only a job actually sitting in the stage is moved. One a dispatcher put
    // somewhere else by hand has been decided about, and must not be overridden.
    if (!job || String(job.status) !== 'open' || Number(job.status_id) !== statusId) return

    const outstanding = await siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM job_part_requests
        WHERE job_card_id = ? AND status IN ('requested','approved','ordered')`,
      [jobId],
    )
    if (Number(outstanding?.n ?? 0) > 0) return

    const onward = await statusForRole(siteId, 'in_progress')
    if (!onward) return
    await setStatus(siteId, actor, jobId, onward.id, 'Every part that was asked for has arrived.')
  } catch {
    /* Same stance as moving in: the goods arriving is what mattered. */
  }
}

/** A buyer agrees, or refuses. Both record who and why. */
export async function decideRequest(
  siteId: number,
  actor: Actor,
  id: number,
  decision: 'approved' | 'cancelled',
  note: string | null,
): Promise<RequestActionResult> {
  const req = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, description, job_card_id FROM job_part_requests WHERE id = ?`,
    [id],
  )
  if (!req) return { ok: false, error: 'That request no longer exists.' }

  const current = String(req.status) as RequestStatus
  /*
   * Only an undecided request can be decided.
   *
   * A request already on an order must not be quietly approved again or
   * cancelled out from under a purchase line that exists — cancelling THAT is a
   * purchasing act, done on the order, and reconcile reports the mismatch if
   * the two ever disagree.
   */
  if (current !== 'requested') {
    return {
      ok: false,
      error: `${String(req.description)} is already ${REQUEST_STATUS_LABEL[current].toLowerCase()}.`,
    }
  }

  await siteExecute(
    siteId,
    `UPDATE job_part_requests
        SET status = ?, decided_by_user_id = ?, decided_by_name = ?,
            decided_at = NOW(), decided_note = ?
      WHERE id = ? AND status = 'requested'`,
    [decision, actor.userId, actor.userName.slice(0, 120), note?.trim().slice(0, 400) || null, id],
  )

  /*
   * A CANCELLED request settles the job's wait just as a delivered one does
   * (§28): the buyer has decided the part is not coming, so the job is no longer
   * waiting for it. Leaving it in Awaiting Parts would strand it in a stage
   * nothing will ever move it out of.
   *
   * Approving does NOT settle anything — the part is still on its way — so this
   * only runs on the refusal branch, and clearAwaitingPartsIfSettled checks
   * every other request on the job before moving anything.
   */
  if (decision === 'cancelled') {
    await clearAwaitingPartsIfSettled(siteId, actor, Number(req.job_card_id))
  }

  return { ok: true }
}

/**
 * Record that a buyer put this request on a purchase line.
 *
 * Takes a line id that purchasing created — this module does not raise the
 * order. Writes BOTH directions: the request remembers its line, and the line
 * remembers the job line, so "what is this job waiting on" and "what is this
 * order for" are each one read.
 */
export async function linkToOrder(
  siteId: number,
  actor: Actor,
  id: number,
  purchaseLineId: number,
): Promise<RequestActionResult> {
  const req = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, job_card_id, job_card_line_id, description
       FROM job_part_requests WHERE id = ?`,
    [id],
  )
  if (!req) return { ok: false, error: 'That request no longer exists.' }
  const current = String(req.status) as RequestStatus
  if (current !== 'approved' && current !== 'requested') {
    return { ok: false, error: `${String(req.description)} is already ${REQUEST_STATUS_LABEL[current].toLowerCase()}.` }
  }

  const line = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM purchase_document_lines WHERE id = ?`,
    [purchaseLineId],
  )
  if (!line) return { ok: false, error: 'That purchase line no longer exists.' }

  await siteTransaction(siteId, async (tx: PoolConnection) => {
    await tx.execute(
      `UPDATE job_part_requests SET status = 'ordered', purchase_line_id = ? WHERE id = ?`,
      [purchaseLineId, id],
    )
    // The other direction, where there is a job line to point at. A request
    // raised with no line (a part nobody has costed yet) leaves this null, and
    // the request row is still the link.
    if (req.job_card_line_id !== null) {
      await tx.execute(
        `UPDATE purchase_document_lines SET job_card_line_id = ? WHERE id = ?`,
        [Number(req.job_card_line_id), purchaseLineId],
      )
    }
  })

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: Number(req.job_card_id),
    action: 'part_ordered',
    detail: String(req.description),
  })
  return { ok: true }
}

/**
 * Goods arrived: move every request on the received lines to `received` and
 * tell the people who asked.
 *
 * ── THE CLAIM COMES BEFORE THE BELL ────────────────────────────────────────
 *
 * The UPDATE is scoped `WHERE status = 'ordered'`, and the rows to notify are
 * read from what that UPDATE actually claimed. So a dead notification channel
 * means one missed message rather than one on every receipt for ever — the
 * pattern lowStockAlert.ts:85 sets, and the reason this is not
 * read-then-notify-then-update.
 *
 * Called from receiveGoods' tail. NEVER throws: goods that arrived have
 * arrived, and a failure here must not misreport a receipt that committed.
 */
export async function markReceivedForDocument(
  siteId: number,
  /**
   * Whoever booked the goods in. Threaded through so the status move out of
   * Awaiting Parts is attributed to a person in the activity log rather than
   * appearing from nowhere — a job that changed stage with no name against it is
   * the kind of entry that makes an audit trail less trusted, not more.
   */
  actor: Actor,
  documentId: number,
): Promise<void> {
  try {
    // Which requests are about to be claimed — read first so the notification
    // has names, but the UPDATE below is what decides.
    const candidates = await siteQuery<Row>(
      siteId,
      `SELECT r.id, r.description, r.qty, r.job_card_id, r.requested_by_user_id,
              j.document_number AS job_number
         FROM job_part_requests r
         JOIN purchase_document_lines pl ON pl.id = r.purchase_line_id
         JOIN job_cards j ON j.id = r.job_card_id
        WHERE pl.document_id = ? AND r.status = 'ordered' AND pl.qty_received > 0`,
      [documentId],
    )
    if (candidates.length === 0) return

    const ids = candidates.map((c) => Number(c.id))
    const claimed = await siteExecute(
      siteId,
      `UPDATE job_part_requests SET status = 'received'
        WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'ordered'`,
      ids,
    )
    if (claimed.affectedRows === 0) return

    for (const c of candidates) {
      /*
       * userId set — the FIRST producer in the codebase to use it.
       *
       * This is a message for the person who asked, not for the shop: they are
       * the one waiting, and an audience-wide version is noise everybody learns
       * to ignore. Where the requester is unknown (a request made before users
       * were tracked, or by a deleted account) it falls back to the jobs
       * audience rather than going nowhere.
       */
      const userId = c.requested_by_user_id === null ? null : Number(c.requested_by_user_id)
      await notify(siteId, {
        event: 'job_part_received',
        audience: userId === null ? 'jobs.view' : null,
        userId,
        title: `Part arrived: ${String(c.description)}`,
        body: `${Number(c.qty)} for ${text(c.job_number) ?? `job #${Number(c.job_card_id)}`}`,
        href: `/jobs/${Number(c.job_card_id)}`,
      })
    }

    /*
     * And take each job back out of Awaiting Parts if nothing is outstanding
     * (§28). Deduplicated: one delivery can settle three requests on one job,
     * and three status moves would write three activity entries saying the same
     * thing.
     */
    for (const jobId of new Set(candidates.map((c) => Number(c.job_card_id)))) {
      await clearAwaitingPartsIfSettled(siteId, actor, jobId)
    }
  } catch {
    // A receipt that committed must not be reported as failed because the
    // request table is missing (a site without 162) or a notification broke.
  }
}

/* ── Reports, never repairs ────────────────────────────────────────────────── */

export type PartRequestDrift = {
  /**
   * Marked `ordered`, but the purchase line has gone.
   *
   * The bucket that catches the trap 163 describes: saveOrder rewrites its
   * lines wholesale, so a buyer editing an order can sever the link. The parts
   * still arrive and no job knows they were its — this is the only thing that
   * would ever say so.
   */
  orderedWithoutLine: { id: number; description: string; jobCardId: number; jobNumber: string | null }[]
  /** Still outstanding on a job that has been closed. Nobody is waiting. */
  openOnClosedJob: { id: number; description: string; jobCardId: number; jobNumber: string | null; status: string }[]
}

export async function reconcileJobPartRequests(siteId: number): Promise<PartRequestDrift> {
  const [orphaned, stale] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT r.id, r.description, r.job_card_id, j.document_number AS job_number
         FROM job_part_requests r
         JOIN job_cards j ON j.id = r.job_card_id
        WHERE r.status = 'ordered'
          AND (r.purchase_line_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM purchase_document_lines pl
                               WHERE pl.id = r.purchase_line_id))
        ORDER BY r.created_at DESC
        LIMIT 500`,
    ).catch(() => []),
    siteQuery<Row>(
      siteId,
      `SELECT r.id, r.description, r.job_card_id, r.status, j.document_number AS job_number
         FROM job_part_requests r
         JOIN job_cards j ON j.id = r.job_card_id
        WHERE r.status IN ('requested','approved','ordered')
          AND j.status <> 'open'
        ORDER BY r.created_at DESC
        LIMIT 500`,
    ).catch(() => []),
  ])

  return {
    orderedWithoutLine: orphaned.map((r) => ({
      id: Number(r.id),
      description: String(r.description),
      jobCardId: Number(r.job_card_id),
      jobNumber: text(r.job_number),
    })),
    openOnClosedJob: stale.map((r) => ({
      id: Number(r.id),
      description: String(r.description),
      jobCardId: Number(r.job_card_id),
      jobNumber: text(r.job_number),
      status: String(r.status),
    })),
  }
}
