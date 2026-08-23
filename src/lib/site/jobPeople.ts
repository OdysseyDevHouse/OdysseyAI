import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import { getSetting } from './settings'
import { listUsers } from './users'
import { dispatch, staffRecipients, type NotifyEvent, type NotifyOutcome } from './jobNotify'

/**
 * Who is on a job, and who hears about it.
 *
 * Sections 16 and 13 of the PRD: a job-level team, and people who watch without
 * being responsible. See the header of 120_job_people.sql for why they share one
 * table with a role rather than getting one each.
 *
 * ── THE OWNER IS NOT IN HERE ────────────────────────────────────────────────
 *
 * job_cards.owner_user_id remains the one person answerable for the job. This
 * module is everybody else, and the owner is deliberately NOT mirrored into a
 * row: two places holding the same fact is two places to disagree, and the
 * screens that matter (the job list, the workload tile) read the column.
 *
 * `peopleFor()` therefore returns the team WITHOUT the owner, and callers that
 * want "everyone involved" ask for that explicitly via `everyoneOn()`.
 *
 * ── FOLLOWING GRANTS NOTHING ────────────────────────────────────────────────
 *
 * A follower row is a subscription, not a permission. What somebody may see is
 * still decided by jobs.view / jobs.view_own, exactly as before. If following
 * granted access, adding a follower would become a way to widen permissions
 * without touching the permissions screen -- which is how an audit finds that
 * nobody knows who can see what.
 */

type Row = RowDataPacket & Record<string, unknown>

export type JobRole = 'assignee' | 'follower'

export type JobPerson = {
  userId: number
  userName: string
  role: JobRole
  addedByName: string
  createdAt: Date
}

export type PeopleResult = { ok: true } | { ok: false; error: string }

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const mapPerson = (r: Row): JobPerson => ({
  userId: Number(r.user_id),
  userName: String(r.user_name ?? ''),
  role: String(r.role) as JobRole,
  addedByName: String(r.added_by_name ?? ''),
  createdAt: r.created_at as Date,
})

/**
 * The team and the watchers on one job, assignees first.
 *
 * Tolerant of a site without migration 120: an empty list, not a thrown error.
 * The same stance reservedQtyFor takes on online holds -- a job card must still
 * open on a site that has not migrated yet.
 */
export async function peopleFor(siteId: number, jobId: number): Promise<JobPerson[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT user_id, user_name, role, added_by_name, created_at
         FROM job_card_people
        WHERE job_card_id = ?
        ORDER BY role ASC, user_name ASC`,
      [jobId],
    )
    return rows.map(mapPerson)
  } catch {
    return []
  }
}

/** Add somebody, or change what they are. Idempotent on the composite key. */
export async function setJobPerson(
  siteId: number,
  actor: Actor,
  jobId: number,
  userId: number,
  role: JobRole,
): Promise<PeopleResult> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, status, owner_user_id, document_number FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) !== 'open') {
    return { ok: false, error: 'This job is closed, so who is on it cannot be changed.' }
  }

  const users = await listUsers(siteId)
  const user = users.find((u) => u.id === userId)
  if (!user) return { ok: false, error: 'That person is not a user on this site.' }
  if (!user.isActive) {
    return { ok: false, error: `${user.name} is no longer active, so cannot be put on a job.` }
  }

  /*
   * The owner is refused rather than silently accepted.
   *
   * Adding the owner as an assignee would put the same person on the job twice
   * in two different places, and the workload count would then double-count
   * them. Saying so is better than quietly ignoring the click, which reads as a
   * broken button.
   */
  if (job.owner_user_id !== null && Number(job.owner_user_id) === userId) {
    return {
      ok: false,
      error: `${user.name} already owns this job. Change the owner instead of adding them again.`,
    }
  }

  // ON DUPLICATE KEY, so promoting a follower to an assignee is one statement
  // and keeps created_at -- when they first got involved is worth keeping.
  await siteExecute(
    siteId,
    `INSERT INTO job_card_people
       (job_card_id, user_id, user_name, role, added_by_user_id, added_by_name)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), user_name = VALUES(user_name)`,
    [jobId, userId, user.name, role, actor.userId, actor.userName],
  )

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: role === 'assignee' ? 'assignee_added' : 'follower_added',
    detail: `${user.name} ${role === 'assignee' ? 'assigned to' : 'following'} this job`,
  })

  // After the write, never inside it: a mail server that is slow or down must
  // not be the reason somebody cannot be assigned work.
  if (role === 'assignee') {
    void notifyAssigned(siteId, jobId, user.id).catch(() => {})
  }

  return { ok: true }
}

/** Take somebody off a job. */
export async function removeJobPerson(
  siteId: number,
  actor: Actor,
  jobId: number,
  userId: number,
): Promise<PeopleResult> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT user_name, role FROM job_card_people WHERE job_card_id = ? AND user_id = ?`,
    [jobId, userId],
  )
  if (!row) return { ok: false, error: 'That person is not on this job.' }

  await siteExecute(
    siteId,
    `DELETE FROM job_card_people WHERE job_card_id = ? AND user_id = ?`,
    [jobId, userId],
  )

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: String(row.role) === 'assignee' ? 'assignee_removed' : 'follower_removed',
    detail: `${String(row.user_name)} taken off this job`,
  })

  return { ok: true }
}

/**
 * Follow or unfollow, by the person themselves.
 *
 * Separate from setJobPerson because the permission is different: putting
 * SOMEBODY ELSE on a job needs jobs.assign, but choosing to watch one you can
 * already see needs nothing beyond being able to see it. Folding the two
 * together would mean either that following required jobs.assign, or that
 * jobs.assign was not enforced on assignment.
 */
export async function toggleFollow(
  siteId: number,
  actor: Actor,
  jobId: number,
): Promise<PeopleResult & { following?: boolean }> {
  const [existing, job] = await Promise.all([
    siteQueryOne<Row>(
      siteId,
      `SELECT role FROM job_card_people WHERE job_card_id = ? AND user_id = ?`,
      [jobId, actor.userId],
    ),
    siteQueryOne<Row>(siteId, `SELECT owner_user_id FROM job_cards WHERE id = ?`, [jobId]),
  ])

  /*
   * The owner is refused here as well as in setJobPerson.
   *
   * Missing this was a real bug, caught by driving the screen: setJobPerson
   * refused the owner, toggleFollow did not, and following your own job wrote
   * exactly the ownerDuplicated row that reconcileJobPeople exists to report.
   * everyoneOn deduplicates so nobody was emailed twice -- but a row that a
   * reconciliation screen calls drift must not be creatable by pressing a button.
   *
   * The owner already hears about everything: everyoneOn adds them from the
   * column, without needing a row.
   */
  if (job?.owner_user_id !== null && Number(job?.owner_user_id) === actor.userId) {
    return {
      ok: false,
      error: 'You own this job, so you already get everything a follower does.',
    }
  }

  // An assignee pressing "unfollow" would take themselves off their own work,
  // which is not what the button says. Refused with the reason.
  if (existing && String(existing.role) === 'assignee') {
    return {
      ok: false,
      error: 'You are assigned to this job, so you already get everything a follower does.',
    }
  }

  if (existing) {
    await siteExecute(
      siteId,
      `DELETE FROM job_card_people WHERE job_card_id = ? AND user_id = ?`,
      [jobId, actor.userId],
    )
    return { ok: true, following: false }
  }

  await siteExecute(
    siteId,
    `INSERT INTO job_card_people
       (job_card_id, user_id, user_name, role, added_by_user_id, added_by_name)
     VALUES (?,?,?, 'follower', ?, ?)
     ON DUPLICATE KEY UPDATE role = 'follower'`,
    [jobId, actor.userId, actor.userName, actor.userId, actor.userName],
  )
  return { ok: true, following: true }
}

/** Job ids this person is on, in either role. One indexed read. */
export async function jobIdsFor(
  siteId: number,
  userId: number,
  role?: JobRole,
): Promise<number[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT job_card_id FROM job_card_people
        WHERE user_id = ?${role ? ' AND role = ?' : ''}`,
      role ? [userId, role] : [userId],
    )
    return rows.map((r) => Number(r.job_card_id))
  } catch {
    return []
  }
}

/**
 * How many people are on each of these jobs, for a list screen.
 *
 * One query for a whole page rather than one per row -- the same shape
 * attachmentCounts uses, and for the same reason.
 */
export async function peopleCounts(
  siteId: number,
  jobIds: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (jobIds.length === 0) return out
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT job_card_id, COUNT(*) AS n FROM job_card_people
        WHERE job_card_id IN (${jobIds.map(() => '?').join(',')})
        GROUP BY job_card_id`,
      [...jobIds],
    )
    rows.forEach((r) => out.set(Number(r.job_card_id), Number(r.n)))
  } catch {
    // Migration 120 not applied. A missing count is a missing badge, not a
    // broken list.
  }
  return out
}

/* ── Telling people ────────────────────────────────────────────────────────
 *
 * Everything below follows the orderNotify contract exactly: it NEVER throws,
 * NEVER blocks the state change that called it, and reports why it did nothing
 * rather than failing silently in a way that looks like success.
 */

/*
 * Both now live in jobNotify, and are re-exported so the dozen call sites that
 * import them from here keep working. The types moved with the sending: an
 * outcome that counts four channels is that module's answer to describe.
 */
export type { NotifyEvent, NotifyOutcome }

/** Which moments are switched on. */
async function enabledEvents(siteId: number): Promise<Set<string>> {
  const raw = await getSetting(siteId, 'job_notify_events').catch(() => '')
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

/**
 * Everyone who should hear about this job: its people, plus the owner.
 *
 * The owner is added here rather than being stored as a row -- see the module
 * header. Deduplicated by user id, because an owner who is also somehow in the
 * table must not be emailed twice.
 */
export async function everyoneOn(siteId: number, jobId: number): Promise<number[]> {
  const [people, job] = await Promise.all([
    peopleFor(siteId, jobId),
    siteQueryOne<Row>(siteId, `SELECT owner_user_id FROM job_cards WHERE id = ?`, [jobId]),
  ])
  const ids = new Set<number>(people.map((p) => p.userId))
  if (job?.owner_user_id !== null && job?.owner_user_id !== undefined) {
    ids.add(Number(job.owner_user_id))
  }
  return [...ids]
}

/**
 * Tells a set of users about a job, on every channel they accept.
 *
 * `exclude` is the person who CAUSED the event. Telling somebody what they
 * themselves just did is the fastest way to teach them the messages are noise.
 *
 * ── THIS IS NOW A THIN WRAPPER, AND THAT IS THE POINT ──────────────────────
 *
 * It used to send the email itself. It now resolves WHO should hear — which is
 * this module's subject — and hands the message to jobNotify.dispatch(), which
 * owns HOW it goes out: bell, email, SMS, WhatsApp, consent, quiet hours,
 * duplicate suppression and the delivery log.
 *
 * The split is deliberate. "Who is on this job" and "which channels has this
 * shop switched on" are different questions with different reasons to change,
 * and mixing them is what left the module able to reach only the people who
 * read email. Every caller keeps the signature it always had.
 *
 * Exported as `notifyAbout` at the bottom of this file so jobAutomations can
 * send its own wording through the same switches and the same never-throw
 * guarantee. A second sender would be a second place for job_notify_enabled to
 * be forgotten.
 */
async function mailAbout(
  siteId: number,
  jobId: number,
  event: NotifyEvent,
  subject: string,
  body: string,
  exclude: number | null,
  recipients?: number[],
): Promise<NotifyOutcome> {
  try {
    const ids = (recipients ?? (await everyoneOn(siteId, jobId))).filter((id) => id !== exclude)
    const who = await staffRecipients(siteId, ids)
    return await dispatch(siteId, jobId, event, { subject, body }, who)
  } catch {
    /*
     * dispatch() already guarantees it does not throw. This guard covers the
     * two lines above it — resolving the audience touches the database, and a
     * job that cannot be closed because a recipient lookup failed is a worse
     * outcome than a notification nobody receives.
     */
    return { sent: 0, skipped: 0, suppressed: 0, failed: 0, reason: null }
  }
}

/** One line naming the job, used in every subject. */
async function jobLabel(siteId: number, jobId: number): Promise<string> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT document_number, title FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return `Job ${jobId}`
  const number = text(job.document_number)
  const title = text(job.title)
  return number && title ? `${number} — ${title}` : (number ?? title ?? `Job ${jobId}`)
}

/** Somebody was given this job. */
export async function notifyAssigned(
  siteId: number,
  jobId: number,
  userId: number,
): Promise<NotifyOutcome> {
  const wanted = await getSetting(siteId, 'job_notify_assignee').catch(() => '1')
  if (wanted === '0') return { sent: 0, skipped: 0, suppressed: 0, failed: 0, reason: 'disabled' }

  const label = await jobLabel(siteId, jobId)
  return mailAbout(
    siteId,
    jobId,
    'assigned',
    `You have been assigned: ${label}`,
    `${label} has been assigned to you.`,
    // NOT excluded: the whole point is telling this person, even when they
    // assigned it to themselves -- which is a normal thing to do at the start of
    // a day and worth a record in the inbox.
    null,
    [userId],
  )
}

/** The job moved. */
export async function notifyStatusChanged(
  siteId: number,
  actor: Actor,
  jobId: number,
  statusName: string,
): Promise<NotifyOutcome> {
  const label = await jobLabel(siteId, jobId)
  return mailAbout(
    siteId,
    jobId,
    'status',
    `${label} is now ${statusName}`,
    `${actor.userName} moved ${label} to ${statusName}.`,
    actor.userId,
  )
}

/** The job is finished. */
export async function notifyClosed(
  siteId: number,
  actor: Actor,
  jobId: number,
): Promise<NotifyOutcome> {
  const label = await jobLabel(siteId, jobId)
  return mailAbout(
    siteId,
    jobId,
    'closed',
    `${label} has been closed`,
    `${actor.userName} closed ${label}.`,
    actor.userId,
  )
}

/**
 * The sender, for callers outside this file.
 *
 * jobAutomations needs to say its own things -- "overdue", "tomorrow" -- but must
 * go through the same switches, recipient rules and never-throw guarantee. Giving
 * it the function rather than letting it call `send` itself is what stops the
 * job_notify_enabled switch from having a second place to be forgotten.
 */
export { mailAbout as notifyAbout }

/* ── Drift ─────────────────────────────────────────────────────────────────── */

export type PeopleDrift = {
  /**
   * Somebody on a job who is no longer an active user on this site.
   *
   * Not repaired, because the fix depends on why: a technician who left needs
   * taking off, but one who is merely deactivated for a month should stay and be
   * reactivated. Removing rows automatically would quietly rewrite the record of
   * who did what.
   */
  goneUsers: { jobId: number; userId: number; userName: string; role: string }[]
  /**
   * The owner also sitting in the table.
   *
   * setJobPerson refuses it, so a row here means the owner CHANGED to somebody
   * already on the job. Worth reporting because it double-counts them on every
   * workload figure.
   */
  ownerDuplicated: { jobId: number; userId: number; userName: string }[]
  /** Assignees whose email is missing, so assignment mail silently does nothing. */
  noAddress: { userId: number; userName: string; jobCount: number }[]
}

/** Reports, never repairs. */
export async function reconcileJobPeople(siteId: number): Promise<PeopleDrift> {
  const empty: PeopleDrift = { goneUsers: [], ownerDuplicated: [], noAddress: [] }
  try {
    const [rows, dupes, users] = await Promise.all([
      siteQuery<Row>(
        siteId,
        `SELECT job_card_id, user_id, user_name, role FROM job_card_people`,
      ),
      siteQuery<Row>(
        siteId,
        `SELECT p.job_card_id, p.user_id, p.user_name
           FROM job_card_people p
           JOIN job_cards j ON j.id = p.job_card_id
          WHERE j.owner_user_id = p.user_id`,
      ),
      listUsers(siteId),
    ])

    const active = new Map(users.map((u) => [u.id, u]))

    const gone = rows
      .filter((r) => {
        const u = active.get(Number(r.user_id))
        return !u || !u.isActive
      })
      .map((r) => ({
        jobId: Number(r.job_card_id),
        userId: Number(r.user_id),
        userName: String(r.user_name),
        role: String(r.role),
      }))

    // Counted per person, not per row: "Piet has no email" said once beats it
    // said for each of his fourteen jobs.
    const byUser = new Map<number, { userName: string; jobCount: number }>()
    rows
      .filter((r) => String(r.role) === 'assignee')
      .forEach((r) => {
        const u = active.get(Number(r.user_id))
        if (!u || !u.isActive || u.email?.trim()) return
        const seen = byUser.get(u.id)
        if (seen) seen.jobCount++
        else byUser.set(u.id, { userName: u.name, jobCount: 1 })
      })

    return {
      goneUsers: gone,
      ownerDuplicated: dupes.map((r) => ({
        jobId: Number(r.job_card_id),
        userId: Number(r.user_id),
        userName: String(r.user_name),
      })),
      noAddress: [...byUser.entries()].map(([userId, v]) => ({ userId, ...v })),
    }
  } catch {
    // Migration 120 not applied on this site.
    return empty
  }
}

/**
 * Everyone on a job, inside a transaction.
 *
 * Takes `tx` so a caller already holding one can read the recipient list before
 * committing -- the countSerialsTx precedent. Tolerant for the same reason as
 * peopleFor: an unmigrated site must not break the close path.
 */
export async function peopleForTx(tx: PoolConnection, jobId: number): Promise<number[]> {
  try {
    const [rows] = await tx.query<Row[]>(
      `SELECT user_id FROM job_card_people WHERE job_card_id = ?`,
      [jobId],
    )
    return rows.map((r) => Number(r.user_id))
  } catch {
    return []
  }
}
