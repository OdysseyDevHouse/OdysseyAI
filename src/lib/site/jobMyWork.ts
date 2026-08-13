import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'

/**
 * What one technician has to do, right now.
 *
 * ── WHY THIS IS NOT A DASHBOARD ────────────────────────────────────────────
 *
 * The PRD is explicit: "This dashboard should prioritise actions rather than
 * management statistics." Everything here is a thing somebody can DO — a job to
 * open, a check to answer, a timer still running, kilometres never submitted.
 * There is no utilisation figure and no chart, because a technician standing in
 * a plant room does not need to know their own throughput.
 *
 * It is also deliberately NOT configurable. The office dashboard is a grid
 * somebody arranges once; this is opened between jobs on a phone, and a screen
 * that must be set up before it is useful will not be.
 *
 * ── EVERY READ IS SCOPED TO ONE PERSON ─────────────────────────────────────
 *
 * `userId` is a parameter rather than something read from a session in here,
 * because this module takes a siteId and answers questions — the action layer
 * decides whose work is being asked about. That also makes "show me what Piet
 * has on" possible for a dispatcher later without changing anything.
 *
 * ── TOLERANT THROUGHOUT ────────────────────────────────────────────────────
 *
 * Each section swallows its own errors and returns empty. A site part-way
 * through the migrations must still be able to open this screen: a technician
 * with no visits showing is a nuisance, a technician facing a stack trace is
 * one who goes back to paper.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * A DATETIME as the wall clock it was stored as.
 *
 * The pool sets the connection timezone to 'Z', so the UTC parts of the driver
 * Date ARE the stored time. Reading them with getUTC* is what keeps an 08:00
 * visit reading as 08:00 on a machine set to SAST rather than 10:00.
 *
 * Copied rather than shared, matching jobAppointments.ts and reservations.ts —
 * see the header on the one in jobAppointments for why `dateStrings` does not
 * remove the need for it.
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

export type MyJob = {
  id: number
  documentNumber: string | null
  title: string
  customerName: string | null
  statusName: string
  priority: string
  /** How they are on it — assigned to them, or they own it. */
  asOwner: boolean
}

export type MyVisit = {
  id: number
  jobCardId: number
  jobNumber: string | null
  jobTitle: string
  customerName: string | null
  addressName: string | null
  startsAt: string
  durationMinutes: number
  status: string
}

export type MyOpenTimer = {
  entryId: number
  jobCardId: number | null
  jobNumber: string | null
  jobTitle: string | null
  startedAt: string
}

export type MyOutstanding = {
  jobCardId: number
  jobNumber: string | null
  jobTitle: string
  /** Required items with no answer yet. Named, not counted — see the comment. */
  items: string[]
}

export type MyWork = {
  /** Every open job this person is on, owner or assignee. */
  jobs: MyJob[]
  /** Today and tomorrow only. Further ahead is what the schedule screen is for. */
  visits: MyVisit[]
  /** A timer left running. The commonest thing a technician forgets. */
  openTimer: MyOpenTimer | null
  /** Required checks still unanswered, on jobs they are on. */
  outstanding: MyOutstanding[]
  /** Travel they recorded that nobody has verified — their pay depends on it. */
  unverifiedTravel: number
}

/** Jobs this person owns or is assigned to, open only. */
async function myJobs(siteId: number, userId: number): Promise<MyJob[]> {
  try {
    /*
     * owner_user_id OR a job_card_people row.
     *
     * A UNION rather than an OR across a join, because the join would multiply
     * a job by its people and then need a DISTINCT — and the two halves answer
     * genuinely different questions ("answerable for" versus "working on").
     */
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT j.id, j.document_number, j.title, j.customer_name, j.priority,
              s.name AS status_name, 1 AS as_owner
         FROM job_cards j JOIN job_statuses s ON s.id = j.status_id
        WHERE j.status = 'open' AND j.owner_user_id = ?
        UNION
       SELECT j.id, j.document_number, j.title, j.customer_name, j.priority,
              s.name AS status_name, 0 AS as_owner
         FROM job_cards j
         JOIN job_statuses s ON s.id = j.status_id
         JOIN job_card_people p ON p.job_card_id = j.id
        WHERE j.status = 'open' AND p.user_id = ? AND p.role = 'assignee'
          AND (j.owner_user_id IS NULL OR j.owner_user_id <> ?)
        ORDER BY FIELD(priority,'urgent','high','normal','low'), id`,
      [userId, userId, userId],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      documentNumber: r.document_number === null ? null : String(r.document_number),
      title: String(r.title),
      customerName: r.customer_name === null ? null : String(r.customer_name),
      statusName: String(r.status_name),
      priority: String(r.priority),
      asOwner: Number(r.as_owner) === 1,
    }))
  } catch {
    return []
  }
}

/** Today and tomorrow, for this person. */
async function myVisits(siteId: number, userId: number): Promise<MyVisit[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT a.id, a.job_card_id, a.starts_at, a.duration_minutes, a.status,
              j.document_number AS job_number, j.title AS job_title, j.customer_name,
              sa.name AS address_name
         FROM job_card_appointments a
         JOIN job_appointment_assignees ass ON ass.appointment_id = a.id
         JOIN job_cards j ON j.id = a.job_card_id
         LEFT JOIN service_addresses sa ON sa.id = a.service_address_id
        WHERE ass.user_id = ?
          AND a.status IN ('scheduled','confirmed','en_route','on_site')
          AND DATE(a.starts_at) BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 1 DAY)
        ORDER BY a.starts_at`,
      [userId],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      jobCardId: Number(r.job_card_id),
      jobNumber: r.job_number === null ? null : String(r.job_number),
      jobTitle: String(r.job_title),
      customerName: r.customer_name === null ? null : String(r.customer_name),
      addressName: r.address_name === null ? null : String(r.address_name),
      startsAt: wallClock(r.starts_at) ?? '',
      durationMinutes: Number(r.duration_minutes ?? 0),
      status: String(r.status),
    }))
  } catch {
    return []
  }
}

/**
 * A timer this person left running.
 *
 * `uq_open_entry` guarantees at most one, so this is LIMIT 1 rather than a list.
 * It is first on the screen because it is the commonest thing a technician
 * forgets, and every hour it runs unnoticed is an hour costed to the wrong job.
 */
async function myOpenTimer(siteId: number, userId: number): Promise<MyOpenTimer | null> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT t.id, t.job_card_id, t.started_at,
              j.document_number AS job_number, j.title AS job_title
         FROM staff_time_entries t
         LEFT JOIN job_cards j ON j.id = t.job_card_id
        WHERE t.user_id = ? AND t.ended_at IS NULL
        ORDER BY t.started_at DESC
        LIMIT 1`,
      [userId],
    )
    if (!row) return null
    return {
      entryId: Number(row.id),
      jobCardId: row.job_card_id === null ? null : Number(row.job_card_id),
      jobNumber: row.job_number === null ? null : String(row.job_number),
      jobTitle: row.job_title === null ? null : String(row.job_title),
      startedAt: wallClock(row.started_at) ?? '',
    }
  } catch {
    return null
  }
}

/**
 * Required checks with no answer, on jobs this person is on.
 *
 * The item NAMES are returned rather than a count, for the reason the close
 * guard gives: "3 outstanding" sends somebody hunting through a list, while
 * "Gas leak test, Customer signature" tells them what to go and do.
 *
 * Capped at three per job — the fourth onwards is a list, and this is a
 * prompt.
 */
async function myOutstanding(siteId: number, userId: number): Promise<MyOutstanding[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT i.job_card_id, i.name,
              j.document_number AS job_number, j.title AS job_title
         FROM job_card_items i
         JOIN job_cards j ON j.id = i.job_card_id
        WHERE j.status = 'open'
          AND i.is_required = 1
          AND (i.completed_at IS NULL
               OR (i.evidence_required = 1 AND i.attachment_id IS NULL))
          AND (j.owner_user_id = ?
               OR EXISTS (SELECT 1 FROM job_card_people p
                           WHERE p.job_card_id = j.id AND p.user_id = ? AND p.role = 'assignee'))
        ORDER BY j.id, i.sort_order
        LIMIT 60`,
      [userId, userId],
    )

    const byJob = new Map<number, MyOutstanding>()
    for (const r of rows) {
      const id = Number(r.job_card_id)
      const seen = byJob.get(id)
      if (seen) {
        if (seen.items.length < 3) seen.items.push(String(r.name))
      } else {
        byJob.set(id, {
          jobCardId: id,
          jobNumber: r.job_number === null ? null : String(r.job_number),
          jobTitle: String(r.job_title),
          items: [String(r.name)],
        })
      }
    }
    return [...byJob.values()]
  } catch {
    return []
  }
}

/** Travel this person recorded that nobody has checked. */
async function myUnverifiedTravel(siteId: number, userId: number): Promise<number> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM job_card_travel
        WHERE user_id = ? AND verified_at IS NULL`,
      [userId],
    )
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

/** Everything, in one pass. */
export async function myWork(siteId: number, userId: number): Promise<MyWork> {
  const [jobs, visits, openTimer, outstanding, unverifiedTravel] = await Promise.all([
    myJobs(siteId, userId),
    myVisits(siteId, userId),
    myOpenTimer(siteId, userId),
    myOutstanding(siteId, userId),
    myUnverifiedTravel(siteId, userId),
  ])
  return { jobs, visits, openTimer, outstanding, unverifiedTravel }
}
