'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  Switch,
  useToast,
} from '@/components/ui'
import type { JobTeam } from '@/lib/site/jobTeams'
import { saveJobTeamAction, deleteJobTeamAction } from '../../actions'

/**
 * Crews — "the North crew" — as a way of assigning several people at once.
 *
 * ── A CREW HOLDS NO JOBS, WHICH IS WHY DELETE IS PLAIN ─────────────────────
 *
 * Every other thing on this screen refuses deletion while something points at
 * it: a status holding jobs, a headline in use. A crew is different — applying
 * one COPIES its people onto the job, so deleting it changes nothing that has
 * already happened. The confirm dialog says exactly that, rather than implying a
 * risk that is not there.
 *
 * ── EDITING ONE DOES NOT REACH BACKWARDS ───────────────────────────────────
 *
 * Take somebody off the crew and last month's jobs are untouched. That surprises
 * people either way round, so the card says it.
 */
export default function TeamsPanel({
  teams,
  users,
}: {
  teams: JobTeam[]
  users: { id: number; name: string }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [editing, setEditing] = useState<JobTeam | 'new' | null>(null)
  const [deleting, setDeleting] = useState<JobTeam | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [members, setMembers] = useState<{ userId: number; isLead: boolean }[]>([])

  function open(team: JobTeam | 'new') {
    setEditing(team)
    if (team === 'new') {
      setName('')
      setDescription('')
      setIsActive(true)
      setMembers([])
    } else {
      setName(team.name)
      setDescription(team.description ?? '')
      setIsActive(team.isActive)
      setMembers(team.members.map((m) => ({ userId: m.userId, isLead: m.isLead })))
    }
  }

  function toggleMember(userId: number, on: boolean) {
    setMembers((prev) =>
      on
        ? [...prev, { userId, isLead: prev.length === 0 }]
        : // Removing the lead leaves the crew leaderless rather than promoting
          // somebody at random — who leads is a decision, not a fallback.
          prev.filter((m) => m.userId !== userId),
    )
  }

  function setLead(userId: number) {
    // Exactly one lead. The server refuses more than one, so the picker enforces
    // it rather than letting somebody build a crew that cannot save.
    setMembers((prev) => prev.map((m) => ({ ...m, isLead: m.userId === userId })))
  }

  function save() {
    start(async () => {
      const result = await saveJobTeamAction({
        id: editing === 'new' || editing === null ? null : editing.id,
        name,
        description: description.trim() || null,
        isActive,
        members,
      })
      if (result.ok) {
        toast.success('Crew saved.')
        setEditing(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove() {
    if (!deleting) return
    start(async () => {
      const result = await deleteJobTeamAction(deleting.id)
      if (result.ok) {
        toast.success(`"${deleting.name}" deleted.`)
        setDeleting(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Crews"
          description="A named group you can put on a job in one go. Choosing a crew adds its people individually — so editing it later never changes a job that has already been done."
          action={
            <Button variant="secondary" onClick={() => open('new')} disabled={pending}>
              <Icons.Plus size={15} />
              Add a crew
            </Button>
          }
        />
        <CardBody className={teams.length === 0 ? undefined : 'p-0'}>
          {teams.length === 0 ? (
            <EmptyState
              icon={<Icons.Users size={22} />}
              title="No crews yet"
              hint="Worth one for each round or vehicle that always works together — a job can then be handed to all of them at once."
            />
          ) : (
            <ul className="divide-y divide-border">
              {teams.map((team) => (
                <li key={team.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm text-ink">{team.name}</span>
                      {!team.isActive && <Badge tone="neutral">Retired</Badge>}
                      {/* A crew with nobody leading it leaves the job with no
                          owner, so it is flagged where it is edited. */}
                      {team.members.length > 0 && !team.members.some((m) => m.isLead) && (
                        <Badge tone="warning">Nobody leads it</Badge>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {team.members.length === 0
                        ? 'Nobody on it'
                        : team.members
                            .map((m) => (m.isLead ? `${m.userName} (leads)` : m.userName))
                            .join(', ')}
                    </span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => open(team)} disabled={pending}>
                    Edit
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Delete ${team.name}`}
                    onClick={() => setDeleting(team)}
                    disabled={pending}
                  >
                    <Icons.Trash size={15} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add a crew' : 'Edit the crew'}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending || !name.trim() || members.length === 0}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="What it is called">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="North crew"
              maxLength={80}
            />
          </Field>
          <Field label="What it is for" hint="Shown in the picker — a name alone means nothing to somebody new.">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="The northern round"
              maxLength={190}
            />
          </Field>

          <div>
            <p className="mb-1.5 text-sm text-ink">Who is on it</p>
            <div className="space-y-1.5">
              {users.map((u) => {
                const member = members.find((m) => m.userId === u.id)
                return (
                  <div key={u.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={Boolean(member)}
                      onChange={(e) => toggleMember(u.id, e.target.checked)}
                      label={u.name}
                    />
                    {member && (
                      <Button
                        variant={member.isLead ? 'primary' : 'ghost'}
                        size="sm"
                        onClick={() => setLead(u.id)}
                        disabled={pending}
                      >
                        {member.isLead ? 'Leads' : 'Make lead'}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
            {/*
             * What the lead IS, and deliberately is not.
             *
             * This said "the lead becomes the job owner", which the screen then
             * disproved: applying a crew leaves the owner alone. Making it true
             * would be the worse fix — a crew put on a job that already has an
             * owner would silently take the job off them.
             */}
            <p className="mt-1.5 text-xs text-muted">
              The lead is who to ask about this crew. Putting the crew on a job does not change
              who owns that job.
            </p>
          </div>

          <Switch
            checked={isActive}
            onChange={setIsActive}
            label="In use"
            hint="Retire a crew to keep it out of the picker without losing its name."
          />
        </div>
      </Modal>

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title={`Delete ${deleting?.name ?? 'this crew'}?`}
        confirmLabel="Delete it"
        tone="danger"
        busy={pending}
        message="Nothing that has already been done changes. A crew is only a shortcut — the people it put on a job stay on that job."
      />
    </>
  )
}
