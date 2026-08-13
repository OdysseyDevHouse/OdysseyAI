import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import { listUsers } from './users'
import { setJobPerson, peopleFor } from './jobPeople'

/**
 * Named crews — "the North crew" — as a way of assigning three people at once.
 *
 * ── A TEAM IS A SHORTCUT, NOT AN OWNER ──────────────────────────────────────
 *
 * See the header of 126_job_teams.sql for the argument in full. In short:
 * selecting a team EXPANDS into individual job_card_people rows, and the job
 * then knows only the people.
 *
 * The consequence worth holding onto is that nothing here needs to be taught to
 * anything else. my-work, the board lanes, the workload figures and the
 * notification recipients all read job_card_people and keep working untouched —
 * a `job_cards.team_id` would have required every one of them to learn about a
 * second source, and would have silently missed half the answer wherever
 * somebody forgot.
 *
 * ── EDITING A CREW DOES NOT REACH BACKWARDS ─────────────────────────────────
 *
 * Take somebody off the North crew and January's jobs are untouched, because
 * those jobs copied the names when the crew was applied. That is the same
 * snapshot rule prices, rates and user names all follow in this schema.
 */

type Row = RowDataPacket & Record<string, unknown>

export type TeamMember = {
  userId: number
  userName: string
  isLead: boolean
}

export type JobTeam = {
  id: number
  name: string
  description: string | null
  isActive: boolean
  sortOrder: number
  members: TeamMember[]
}

export type TeamResult = { ok: true; id: number } | { ok: false; error: string }
export type TeamActionResult = { ok: true } | { ok: false; error: string }

/**
 * What applying a crew did.
 *
 * `skipped` is the point, exactly as it is for the bulk bar: "3 added" with no
 * mention of the fourth is worse than not saying anything, because the user
 * cannot tell whether the one that mattered went on.
 */
export type ApplyTeamResult = {
  added: number
  skipped: { userName: string; reason: string }[]
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Every crew, with its people. Tolerant of a site without migration 126. */
export async function listJobTeams(siteId: number, includeInactive = false): Promise<JobTeam[]> {
  try {
    const [teams, members] = await Promise.all([
      siteQuery<Row>(
        siteId,
        `SELECT id, name, description, is_active, sort_order
           FROM job_teams
          ${includeInactive ? '' : 'WHERE is_active = 1'}
          ORDER BY sort_order, name`,
      ),
      siteQuery<Row>(
        siteId,
        `SELECT team_id, user_id, user_name, is_lead
           FROM job_team_members
          ORDER BY is_lead DESC, sort_order, user_name`,
      ),
    ])

    return teams.map((t) => ({
      id: Number(t.id),
      name: String(t.name),
      description: text(t.description),
      isActive: Number(t.is_active) === 1,
      sortOrder: Number(t.sort_order),
      members: members
        .filter((m) => Number(m.team_id) === Number(t.id))
        .map((m) => ({
          userId: Number(m.user_id),
          userName: String(m.user_name ?? ''),
          isLead: Number(m.is_lead) === 1,
        })),
    }))
  } catch {
    return []
  }
}

export async function getJobTeam(siteId: number, id: number): Promise<JobTeam | null> {
  const teams = await listJobTeams(siteId, true)
  return teams.find((t) => t.id === id) ?? null
}

/**
 * Create or replace a crew and its membership.
 *
 * Members are REPLACED wholesale rather than diffed, matching how headlines save
 * their items: a crew is a short list somebody edits as a whole, and diffing
 * would need stable ids through a reorder for no gain.
 */
export async function saveJobTeam(
  siteId: number,
  actor: Actor,
  input: {
    id: number | null
    name: string
    description: string | null
    isActive: boolean
    members: { userId: number; isLead: boolean }[]
  },
): Promise<TeamResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'A crew needs a name.' }
  if (name.length > 80) return { ok: false, error: 'That name is too long.' }

  const unique = [...new Map(input.members.map((m) => [m.userId, m])).values()]
  if (unique.length === 0) {
    return { ok: false, error: 'A crew with nobody in it does nothing. Add at least one person.' }
  }

  /*
   * More than one lead is refused rather than silently corrected.
   *
   * The lead is who becomes the job owner when the crew is applied, and a
   * "correction" that picked one at random would put the wrong name on the job
   * every time somebody made this mistake.
   */
  if (unique.filter((m) => m.isLead).length > 1) {
    return { ok: false, error: 'Only one person can lead a crew. Pick one.' }
  }

  // Validated against real users, so a crew cannot name somebody who left.
  const users = await listUsers(siteId)
  const byId = new Map(users.map((u) => [u.id, u]))
  for (const m of unique) {
    const user = byId.get(m.userId)
    if (!user) return { ok: false, error: 'One of those people is not a user on this site.' }
    if (!user.isActive) {
      return { ok: false, error: `${user.name} is no longer active, so cannot be on a crew.` }
    }
  }

  try {
    return await siteTransaction(siteId, async (tx) => {
      let id = input.id
      if (id === null) {
        const [res] = await tx.execute<import('mysql2/promise').ResultSetHeader>(
          `INSERT INTO job_teams (name, description, is_active, sort_order)
           VALUES (?,?,?, COALESCE((SELECT n FROM (SELECT MAX(sort_order) + 10 AS n FROM job_teams) t), 0))`,
          [name, text(input.description), input.isActive ? 1 : 0],
        )
        id = Number(res.insertId)
      } else {
        await tx.execute(
          `UPDATE job_teams SET name = ?, description = ?, is_active = ? WHERE id = ?`,
          [name, text(input.description), input.isActive ? 1 : 0, id],
        )
        await tx.execute(`DELETE FROM job_team_members WHERE team_id = ?`, [id])
      }

      for (const [index, m] of unique.entries()) {
        await tx.execute(
          `INSERT INTO job_team_members (team_id, user_id, user_name, is_lead, sort_order)
           VALUES (?,?,?,?,?)`,
          [id, m.userId, byId.get(m.userId)?.name ?? '', m.isLead ? 1 : 0, index],
        )
      }

      return { ok: true as const, id: id as number }
    })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ER_DUP_ENTRY') {
      return { ok: false, error: `There is already a crew called "${name}".` }
    }
    if (code === 'ER_NO_SUCH_TABLE') {
      return { ok: false, error: 'Crews are not set up on this site yet.' }
    }
    throw error
  }
}

/**
 * Delete a crew.
 *
 * Always allowed, and this is worth naming: a crew holds no jobs. Its members
 * were copied onto every job it was applied to, so deleting it changes nothing
 * that already happened — unlike a status or a headline, both of which refuse
 * deletion while anything points at them.
 */
export async function deleteJobTeam(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<TeamActionResult> {
  const team = await getJobTeam(siteId, id)
  if (!team) return { ok: false, error: 'That crew no longer exists.' }

  // Members CASCADE from the team.
  await siteExecute(siteId, `DELETE FROM job_teams WHERE id = ?`, [id])
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: null,
    action: 'team_deleted',
    detail: `Deleted the crew "${team.name}"`,
  }).catch(() => {})

  return { ok: true }
}

/**
 * Put a whole crew on a job.
 *
 * ── IT GOES THROUGH THE SAME DOOR ───────────────────────────────────────────
 *
 * setJobPerson per member, not a bulk INSERT. That door refuses somebody who is
 * already the owner, refuses an inactive user, logs the change and fires the
 * assignment notification — and a crew that bypassed all of it would produce
 * jobs subtly unlike the ones assigned one name at a time.
 *
 * The cost is honest: applying a five-person crew is five round trips and five
 * emails. Both are correct. Five people were each given work.
 */
export async function applyTeamToJob(
  siteId: number,
  actor: Actor,
  jobId: number,
  teamId: number,
): Promise<ApplyTeamResult & { ok: boolean; error?: string }> {
  const team = await getJobTeam(siteId, teamId)
  if (!team) return { ok: false, error: 'That crew no longer exists.', added: 0, skipped: [] }
  if (!team.isActive) {
    return { ok: false, error: `${team.name} has been retired.`, added: 0, skipped: [] }
  }

  const skipped: ApplyTeamResult['skipped'] = []
  let added = 0

  /*
   * Who is already on it, checked HERE rather than left to setJobPerson.
   *
   * That door is deliberately idempotent — its INSERT is ON DUPLICATE KEY UPDATE,
   * so setting somebody who is already an assignee succeeds and is how a follower
   * gets promoted. Correct for one name at a time, wrong for a crew: putting the
   * North crew on twice would report "3 added" having added nobody, and would
   * send three people a second email telling them about work they already had.
   */
  const already = new Map(
    (await peopleFor(siteId, jobId)).map((p) => [p.userId, p.role] as const),
  )

  for (const member of team.members) {
    const existing = already.get(member.userId)
    if (existing === 'assignee') {
      skipped.push({ userName: member.userName, reason: 'Already on this job.' })
      continue
    }
    const result = await setJobPerson(siteId, actor, jobId, member.userId, 'assignee')
    if (result.ok) added++
    else skipped.push({ userName: member.userName, reason: result.error })
  }

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'team_applied',
    // The crew is named HERE and nowhere else — see the schema header. After
    // expansion the job knows only the people, so the log is the only record
    // that a crew was chosen rather than three names picked individually.
    detail: `${team.name} put on the job — ${added} added${skipped.length ? `, ${skipped.length} skipped` : ''}`,
  }).catch(() => {})

  return { ok: true, added, skipped }
}

export type TeamDrift = {
  /**
   * A crew member who is no longer an active user.
   *
   * Not repaired, because the fix depends on why: somebody who left needs taking
   * off, somebody deactivated for a month should stay. Removing them
   * automatically would quietly change who the crew is.
   */
  goneMembers: { teamId: number; teamName: string; userId: number; userName: string }[]
  /** A crew with nobody in it, or nobody leading it. */
  emptyTeams: { teamId: number; teamName: string; reason: string }[]
}

/** Reports, never repairs. */
export async function reconcileJobTeams(siteId: number): Promise<TeamDrift> {
  try {
    const [teams, users] = await Promise.all([listJobTeams(siteId, true), listUsers(siteId)])
    const active = new Map(users.map((u) => [u.id, u]))

    const goneMembers: TeamDrift['goneMembers'] = []
    const emptyTeams: TeamDrift['emptyTeams'] = []

    for (const team of teams) {
      for (const m of team.members) {
        const user = active.get(m.userId)
        if (!user || !user.isActive) {
          goneMembers.push({
            teamId: team.id,
            teamName: team.name,
            userId: m.userId,
            userName: m.userName,
          })
        }
      }
      if (team.members.length === 0) {
        emptyTeams.push({ teamId: team.id, teamName: team.name, reason: 'Nobody is on it' })
      } else if (!team.members.some((m) => m.isLead)) {
        /*
         * No lead is drift rather than an error, because saveJobTeam permits it:
         * a crew mid-edit legitimately has nobody marked yet. What it means when
         * it persists is that nobody is named as the person to ask about this
         * crew — which is the whole of what a lead is. Applying it still works,
         * and still leaves the job owner alone.
         */
        emptyTeams.push({ teamId: team.id, teamName: team.name, reason: 'Nobody leads it' })
      }
    }

    return { goneMembers, emptyTeams }
  } catch {
    return { goneMembers: [], emptyTeams: [] }
  }
}
