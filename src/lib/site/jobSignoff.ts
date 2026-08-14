import 'server-only'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { logActivityTx, type Actor } from './activityLog'
import { getSetting } from './settings'

/**
 * Who signed a job off: the customer, and whoever did the work.
 *
 * ── WHY THIS IS NOT A CHECKLIST ITEM ───────────────────────────────────────
 *
 * It very nearly is, and that is worth saying plainly: 114 gives an item a
 * response_type of `signature`, 119 attaches a real drawn PNG to it, and a site
 * can already make one mandatory before closing. Everything below reuses that
 * machinery — the same SignaturePad, the same party_documents row, the same
 * uploads directory.
 *
 * What it cannot do is answer a question. Nothing in the schema knows which
 * signature item is the CUSTOMER'S: both are rows whose name somebody typed,
 * and the wording differs per site and per kind of work. So "completed jobs
 * missing a customer signature" — a report the PRD asks for by name — would
 * mean matching on configurable text. Two named pairs of columns make it one
 * indexed read, which is the whole reason 159 exists.
 *
 * ── THE MARK IS THE EVIDENCE; THE NAME IS THE CLAIM ────────────────────────
 *
 * `signedName` is typed by the person signing and is not looked up. The person
 * holding the tablet is very often not the person named on the account — a site
 * foreman, a receptionist, a tenant — and a mark with a name against it is
 * worth more than a mark alone. For the technician side it defaults to the
 * actor's own name, because there the two almost always agree.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * A stored DATETIME as the wall clock it was written as.
 *
 * The same helper, for the same reason, as wallClock() in jobAppointments.ts —
 * the pool sets the connection timezone to 'Z', so String(driverDate) yields a
 * LOCALE string and the naive `+ 'Z'` fix yields NaN. Copied rather than shared
 * because every module here keeps its own; see that header for the full account.
 */
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

export type SignoffParty = 'customer' | 'technician'

export type JobSignoff = {
  customer: SignoffMark | null
  technician: SignoffMark | null
}

export type SignoffMark = {
  name: string | null
  at: string
  attachmentId: number | null
  /** The stored file, for a viewer or the PDF. Null if the file was deleted. */
  storedName: string | null
  mimeType: string | null
}

/**
 * What a site demands before a job may close.
 *
 * Three values rather than two flags, because two flags allow "technician only",
 * which nobody asks for: a technician signature exists to accompany a customer's,
 * not to stand alone.
 */
export type SignoffRule = 'none' | 'customer' | 'both'

const RULES = new Set<SignoffRule>(['none', 'customer', 'both'])

export async function signoffRule(siteId: number): Promise<SignoffRule> {
  // Tolerant of a site without 159 — a missing setting must never stop a job
  // being closed, which is the same rule itemsBlockClose follows.
  const raw = await getSetting(siteId, 'job_signoff_required').catch(() => 'none')
  const value = String(raw ?? 'none').trim() as SignoffRule
  return RULES.has(value) ? value : 'none'
}

const PARTIES: Record<SignoffParty, { at: string; name: string; sig: string; label: string }> = {
  customer: {
    at: 'customer_signed_at',
    name: 'customer_signed_name',
    sig: 'customer_signature_id',
    label: 'Customer',
  },
  technician: {
    at: 'technician_signed_at',
    name: 'technician_signed_name',
    sig: 'technician_signature_id',
    label: 'Technician',
  },
}

/**
 * Both marks on a job, with the stored file resolved.
 *
 * `.catch` gives null rather than throwing on a site that has not run 159: the
 * job screen must render without a sign-off card rather than 500.
 */
export async function jobSignoff(siteId: number, jobId: number): Promise<JobSignoff> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT customer_signed_at, customer_signed_name, customer_signature_id,
            technician_signed_at, technician_signed_name, technician_signature_id
       FROM job_cards WHERE id = ?`,
    [jobId],
  ).catch(() => null)

  if (!row) return { customer: null, technician: null }

  const ids = [row.customer_signature_id, row.technician_signature_id]
    .map((v) => (v === null || v === undefined ? null : Number(v)))
    .filter((v): v is number => v !== null)

  /*
   * The STORED name, not the display filename.
   *
   * Phase 32 lost every image in the PDF to exactly this: party_documents holds
   * both, `filename` is what a person reads and `stored_name` is what is on
   * disk, and passing the wrong one to readStoredFile silently finds nothing.
   */
  const files = new Map<number, { storedName: string; mimeType: string | null }>()
  if (ids.length > 0) {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, stored_name, mime_type FROM party_documents
        WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    ).catch(() => [])
    for (const f of rows) {
      files.set(Number(f.id), {
        storedName: String(f.stored_name),
        mimeType: f.mime_type === null ? null : String(f.mime_type),
      })
    }
  }

  function mark(atValue: unknown, nameValue: unknown, sigValue: unknown): SignoffMark | null {
    const at = wallClock(atValue)
    if (at === null) return null
    const attachmentId =
      sigValue === null || sigValue === undefined ? null : Number(sigValue)
    const file = attachmentId === null ? null : files.get(attachmentId) ?? null
    return {
      name: nameValue === null || nameValue === undefined ? null : String(nameValue),
      at,
      attachmentId,
      storedName: file?.storedName ?? null,
      mimeType: file?.mimeType ?? null,
    }
  }

  return {
    customer: mark(row.customer_signed_at, row.customer_signed_name, row.customer_signature_id),
    technician: mark(
      row.technician_signed_at,
      row.technician_signed_name,
      row.technician_signature_id,
    ),
  }
}

export type SignoffResult = { ok: true } | { ok: false; error: string }

/**
 * File a signature against a job as one party or the other.
 *
 * The drawn PNG becomes an ordinary party_documents row on the job, exactly as
 * checklist evidence does, so it appears on the Files tab and is backed up with
 * everything else. Only WHERE the id is filed differs.
 *
 * ── RE-SIGNING REPLACES THE LINK, NOT THE FILE ─────────────────────────────
 *
 * Following captureEvidence verbatim: the previous document row stays. A
 * customer who re-signed because the first mark smudged has not made the first
 * one untrue, and deleting evidence on a second upload is the wrong default for
 * the one table where evidence lives.
 */
export async function signJob(
  siteId: number,
  actor: Actor,
  jobId: number,
  party: SignoffParty,
  file: { storedName: string; filename: string; mimeType: string | null; sizeBytes: number },
  signedName: string | null,
): Promise<SignoffResult> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }

  /*
   * A closed job cannot be signed.
   *
   * Not a nicety: the whole point of the rule below is that the signature comes
   * BEFORE the close. Allowing one afterwards would mean a job could be closed
   * unsigned and then signed at leisure, which makes the guard decorative — the
   * same argument 114 makes about a required flag that blocks nothing.
   */
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so it cannot be signed now.' }
  }

  const columns = PARTIES[party]
  // The technician side defaults to who is holding the device, because there the
  // signer and the account almost always agree. The customer side never does:
  // an unnamed customer mark stays unnamed rather than being labelled with the
  // staff member who handed over the tablet.
  const name =
    signedName?.trim() || (party === 'technician' ? actor.userName : null)

  await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute<ResultSetHeader>(
      `INSERT INTO party_documents
         (entity, entity_id, filename, stored_name, mime_type, size_bytes,
          description, uploaded_by, uploaded_name)
       VALUES ('job_card',?,?,?,?,?,?,?,?)`,
      [
        jobId,
        file.filename.slice(0, 255),
        file.storedName.slice(0, 190),
        file.mimeType?.slice(0, 120) ?? null,
        Math.max(0, Math.trunc(file.sizeBytes)),
        `${columns.label} signature${name ? ` — ${name}` : ''}`.slice(0, 400),
        actor.userId,
        actor.userName.slice(0, 120),
      ],
    )

    await tx.execute(
      `UPDATE job_cards
          SET ${columns.at} = NOW(), ${columns.name} = ?, ${columns.sig} = ?
        WHERE id = ?`,
      [name === null ? null : name.slice(0, 120), Number(res.insertId), jobId],
    )

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'signed',
      detail: name ? `${columns.label} signature — ${name}` : `${columns.label} signature`,
    })
  })

  return { ok: true }
}

/**
 * Undo a sign-off.
 *
 * Clears the three columns and leaves the document row alone, for the reason
 * above: the mark was made and the file is the record of it. What is being
 * withdrawn is the CLAIM that this job is signed off, which is what the columns
 * are for.
 */
export async function unsignJob(
  siteId: number,
  actor: Actor,
  jobId: number,
  party: SignoffParty,
): Promise<SignoffResult> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so its sign-off cannot be changed.' }
  }

  const columns = PARTIES[party]

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE job_cards
          SET ${columns.at} = NULL, ${columns.name} = NULL, ${columns.sig} = NULL
        WHERE id = ?`,
      [jobId],
    )
    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'signed',
      detail: `${columns.label} signature withdrawn`,
    })
  })

  return { ok: true }
}

/**
 * What is missing before this job may close, as a sentence, or null.
 *
 * Returns the words rather than a boolean so the caller does not have to
 * re-derive them, matching outstandingRequiredTx: naming what to go and do
 * beats reporting that something is wrong.
 *
 * ── WHY THIS TAKES THE CONNECTION ──────────────────────────────────────────
 *
 * It reads `job_cards`, which is the row setStatus's transaction has already
 * locked. Reading it through siteQueryOne would take a SECOND connection out of
 * the pool and wait on a lock the caller itself holds — a deadlock that would
 * surface as a hung close, not an error.
 *
 * That is why the two existing guards split the way they do: itemsBlockClose
 * reads a SETTING and goes through the pool, outstandingRequiredTx reads the
 * job's own rows and takes the tx. This is the second kind.
 */
export async function missingSignoffTx(
  tx: PoolConnection,
  jobId: number,
  rule: SignoffRule,
): Promise<string | null> {
  if (rule === 'none') return null

  let row: Row | null = null
  try {
    const [rows] = await tx.query<Row[]>(
      `SELECT customer_signed_at, technician_signed_at FROM job_cards WHERE id = ?`,
      [jobId],
    )
    row = rows[0] ?? null
  } catch {
    row = null
  }

  // A site without 159 has no columns to read, so nothing is missing. The
  // alternative — refusing every close — is the worse failure by a distance.
  if (!row) return null

  const needs: string[] = []
  if (row.customer_signed_at === null || row.customer_signed_at === undefined) {
    needs.push('the customer')
  }
  if (
    rule === 'both' &&
    (row.technician_signed_at === null || row.technician_signed_at === undefined)
  ) {
    needs.push('a technician')
  }
  if (needs.length === 0) return null

  return `This job needs a signature from ${needs.join(' and ')} before it can be closed.`
}

/**
 * Jobs that closed without the signature they were supposed to carry (§65).
 *
 * A REPORT, never a repair — the module's standing rule. Nothing here signs
 * anything or reopens a job: a job that closed unsigned did close unsigned, and
 * the only honest response is to say so and let a person deal with it.
 *
 * Reads the rule as it is TODAY and applies it to history, which is the right
 * way round for a chase list: a business that has just started demanding
 * signatures wants to know which of last month's jobs it never got.
 */
export async function reconcileSignoff(
  siteId: number,
): Promise<{ closedUnsigned: Array<{ id: number; documentNumber: string | null; title: string; closedAt: string | null; missing: string }> }> {
  const rule = await signoffRule(siteId)
  if (rule === 'none') return { closedUnsigned: [] }

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, document_number, title, closed_at,
            customer_signed_at, technician_signed_at
       FROM job_cards
      WHERE status = 'closed'
        AND (customer_signed_at IS NULL
             ${rule === 'both' ? 'OR technician_signed_at IS NULL' : ''})
      ORDER BY closed_at DESC
      LIMIT 500`,
  ).catch(() => [])

  return {
    closedUnsigned: rows.map((r) => {
      const missing: string[] = []
      if (r.customer_signed_at === null || r.customer_signed_at === undefined) {
        missing.push('customer')
      }
      if (
        rule === 'both' &&
        (r.technician_signed_at === null || r.technician_signed_at === undefined)
      ) {
        missing.push('technician')
      }
      return {
        id: Number(r.id),
        documentNumber: r.document_number === null ? null : String(r.document_number),
        title: String(r.title),
        closedAt: wallClock(r.closed_at),
        missing: missing.join(' and '),
      }
    }),
  }
}
