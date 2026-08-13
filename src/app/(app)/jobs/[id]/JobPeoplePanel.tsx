'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Icons,
  Select,
  useToast,
} from '@/components/ui'
import type { JobPerson, JobRole } from '@/lib/site/jobPeople'
import {
  removeJobPersonAction,
  setJobPersonAction,
  toggleFollowAction,
  applyTeamToJobAction,
} from '../actions'

/**
 * The team on a job, and the people watching it.
 *
 * ── ONE LIST, TWO GROUPS ───────────────────────────────────────────────────
 *
 * Assignees and followers share a table and share this card, split by a heading
 * rather than by a tab. They are the same question asked twice — who is involved
 * — and two tabs would make somebody click to find out whether the manager who
 * asked about this job is watching it.
 *
 * ── THE OWNER IS SHOWN BUT NOT LISTED HERE ─────────────────────────────────
 *
 * job_cards.owner_user_id is the one person answerable, edited on the Overview
 * tab where it has always been. Repeating it as a row would invite editing it in
 * two places, and the server refuses to put the owner in this table precisely so
 * the two cannot disagree.
 */
export default function JobPeoplePanel({
  jobId,
  jobClosed,
  ownerName,
  ownerUserId,
  people,
  users,
  currentUserId,
  canAssign,
  notifyOff,
  teams,
}: {
  jobId: number
  jobClosed: boolean
  ownerName: string
  /**
   * The id, not just the name. owner_name is a snapshot that can disagree with
   * owner_user_id — a live job on this site has "Naledi K" stored against user 1,
   * Tiaan Smith — so matching on the name would get the owner check wrong.
   */
  ownerUserId: number | null
  people: JobPerson[]
  users: { id: number; name: string }[]
  currentUserId: number
  canAssign: boolean
  /** True when job_notify_enabled is off, so the card can say so rather than lie. */
  notifyOff: boolean
  /** Active crews. Empty when none are set up, and the picker then stays hidden. */
  teams: { id: number; name: string; memberCount: number }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [picked, setPicked] = useState('')
  const [role, setRole] = useState<JobRole>('assignee')
  const [crew, setCrew] = useState('')

  function addCrew() {
    const teamId = Number(crew)
    if (!Number.isFinite(teamId) || teamId <= 0) return
    start(async () => {
      const result = await applyTeamToJobAction(jobId, teamId)
      if (!result.ok) {
        toast.error(result.error ?? 'That crew could not be added.')
        return
      }
      /*
       * The skipped list is named, not counted. Somebody already on the job is
       * the commonest reason — putting the North crew on twice should say so
       * rather than silently adding two of the three.
       */
      if (result.skipped.length > 0) {
        toast.success(
          `${result.added} added. Left alone: ${result.skipped
            .map((s) => s.userName)
            .join(', ')}.`,
        )
      } else {
        toast.success(`${result.added} added.`)
      }
      setCrew('')
      router.refresh()
    })
  }

  const assignees = people.filter((p) => p.role === 'assignee')
  const followers = people.filter((p) => p.role === 'follower')
  const meFollowing = followers.some((p) => p.userId === currentUserId)
  const meAssigned = assignees.some((p) => p.userId === currentUserId)
  const meOwner = ownerUserId !== null && ownerUserId === currentUserId

  // Anybody already on the job is out of the picker: adding them again would
  // silently change their role, which is not what "Add" says it does. Changing a
  // role is the button on their own row.
  //
  // The owner is out for a different reason — the server refuses them, because a
  // person in both places is counted twice on every workload figure. Offering a
  // name that always errors is worse than not offering it.
  const onJob = new Set(people.map((p) => p.userId))
  if (ownerUserId !== null) onJob.add(ownerUserId)
  const available = users.filter((u) => !onJob.has(u.id))

  function add() {
    const userId = Number(picked)
    if (!Number.isFinite(userId) || userId <= 0) return
    start(async () => {
      const result = await setJobPersonAction(jobId, userId, role)
      if (result.ok) {
        toast.success(role === 'assignee' ? 'Assigned.' : 'Following.')
        setPicked('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function change(person: JobPerson, next: JobRole) {
    start(async () => {
      const result = await setJobPersonAction(jobId, person.userId, next)
      if (result.ok) router.refresh()
      else toast.error(result.error)
    })
  }

  function remove(person: JobPerson) {
    start(async () => {
      const result = await removeJobPersonAction(jobId, person.userId)
      if (result.ok) router.refresh()
      else toast.error(result.error)
    })
  }

  function follow() {
    start(async () => {
      const result = await toggleFollowAction(jobId)
      if (result.ok) {
        toast.success(result.following ? 'You are following this job.' : 'No longer following.')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const row = (person: JobPerson) => (
    <div
      key={person.userId}
      className="flex items-center gap-2 border-b border-border py-2 last:border-b-0"
    >
      <Icons.Users size={15} className="text-muted" />
      <span className="flex-1 text-sm text-ink">{person.userName}</span>
      {person.userId === currentUserId && <Badge tone="neutral">You</Badge>}
      {person.addedByName && (
        <span className="text-xs text-muted">added by {person.addedByName}</span>
      )}
      {canAssign && !jobClosed && (
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => change(person, person.role === 'assignee' ? 'follower' : 'assignee')}
          >
            {person.role === 'assignee' ? 'Make a follower' : 'Assign'}
          </Button>
          <Button
            variant="danger-ghost"
            size="sm"
            iconOnly
            aria-label={`Take ${person.userName} off this job`}
            disabled={pending}
            onClick={() => remove(person)}
          >
            <Icons.Trash size={15} />
          </Button>
        </>
      )}
    </div>
  )

  return (
    <Card>
      <CardHeader
        title="People"
        description={
          notifyOff
            ? 'Emails are switched off, so nobody here is being told anything.'
            : 'Assignees do the work. Followers are told when it moves, and hold no extra access.'
        }
        action={
          // Hidden for the owner and for assignees: both already get everything a
          // follower does, so the button would be a lie. The server refuses both
          // too — the owner case was a real bug found by pressing this button,
          // which wrote the very row the reconciliation screen calls drift.
          !meAssigned && !meOwner && !jobClosed ? (
            <Button variant="secondary" disabled={pending} onClick={follow}>
              <Icons.Bell size={15} />
              {meFollowing ? 'Stop following' : 'Follow this job'}
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        <div className="space-y-4">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
              Responsible
            </p>
            <div className="flex items-center gap-2 py-2 text-sm">
              <Icons.Users size={15} className="text-muted" />
              <span className="flex-1 text-ink">{ownerName || 'Nobody yet'}</span>
              <span className="text-xs text-muted">Owner — set on Overview</span>
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
              Also working on it ({assignees.length})
            </p>
            {assignees.length === 0 ? (
              <p className="py-2 text-sm text-muted">Nobody else is assigned.</p>
            ) : (
              assignees.map(row)
            )}
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
              Watching ({followers.length})
            </p>
            {followers.length === 0 ? (
              <p className="py-2 text-sm text-muted">Nobody is following this job.</p>
            ) : (
              followers.map(row)
            )}
          </div>

          {canAssign && !jobClosed && (
            <div className="flex items-end gap-2 border-t border-border pt-3">
              <div className="flex-1">
                <Select
                  value={picked}
                  onChange={(e) => setPicked(e.target.value)}
                  disabled={pending || available.length === 0}
                >
                  <option value="">
                    {available.length === 0 ? 'Everybody is already on this job' : 'Choose a person…'}
                  </option>
                  {available.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-40">
                <Select
                  value={role}
                  onChange={(e) => setRole(e.target.value as JobRole)}
                  disabled={pending}
                >
                  <option value="assignee">as an assignee</option>
                  <option value="follower">as a follower</option>
                </Select>
              </div>
              <Button disabled={pending || !picked} onClick={add}>
                <Icons.Plus size={15} />
                Add
              </Button>
            </div>
          )}

          {/* A crew is a shortcut into the row above, not a different kind of
              thing — so it sits under it rather than beside it, and putting one
              on adds the same assignee rows a person would add by hand. */}
          {canAssign && !jobClosed && teams.length > 0 && (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Select
                  value={crew}
                  onChange={(e) => setCrew(e.target.value)}
                  disabled={pending}
                >
                  <option value="">…or put a whole crew on</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.memberCount})
                    </option>
                  ))}
                </Select>
              </div>
              <Button variant="secondary" disabled={pending || !crew} onClick={addCrew}>
                <Icons.Users size={15} />
                Add the crew
              </Button>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
