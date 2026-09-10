'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardBody,
  Checkbox,
  Field,
  Input,
  Select,
  Switch,
  Modal,
  Icons,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  type BadgeTone,
} from '@/components/ui'
import type { JobStatus } from '@/lib/site/jobStatuses'
import {
  REQUIRED_ROLES,
  ROLE_LABEL,
  isClosed,
  type JobStatusRole,
  type JobStatusTone,
} from '@/lib/jobStatusModel'
import { saveStatusAction, deleteStatusAction, reorderStatusesAction } from '../../actions'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

const TONES: JobStatusTone[] = ['neutral', 'brand', 'success', 'warning', 'danger']

/**
 * The stages a job moves through.
 *
 * ── WHY THIS IS NO LONGER THE SAME COMPONENT AS BOARDS ─────────────────────
 *
 * Stages and boards used to be two cards in one client, on one route called
 * "Workflow". Splitting them is not cosmetic: a status belongs to no board and a
 * board holds no jobs, and one screen showing both invited exactly the mental
 * model this module rejects — that a stage lives on a board. Two routes make the
 * independence structural rather than a paragraph somebody has to read.
 *
 * The board editor still needs the stage list, but only to TICK: it receives it
 * as read-only data from its own page's query, and cannot reorder or rename one.
 *
 * Reordering is buttons rather than drag-and-drop. The list is eight rows set
 * once a year, and a drag surface here would cost a dnd context, a sensor set and
 * a keyboard story to save two clicks on a screen nobody opens twice.
 */
export default function StatusesClient({
  statuses,
  offBoardIds,
}: {
  statuses: JobStatus[]
  /** Stages on no board at all — the trap, flagged on the row that causes it. */
  offBoardIds: number[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [editing, setEditing] = useState<JobStatus | 'new' | null>(null)
  const [name, setName] = useState('')
  const [tone, setTone] = useState<JobStatusTone>('neutral')
  const [role, setRole] = useState<JobStatusRole>('')
  const [isActive, setIsActive] = useState(true)
  const [requiresReason, setRequiresReason] = useState(false)
  const [blocksOnIncomplete, setBlocksOnIncomplete] = useState<boolean | null>(null)
  const [audience, setAudience] = useState<'anyone' | 'office'>('anyone')
  const [isClosedStage, setIsClosedStage] = useState(false)

  const offBoard = new Set(offBoardIds)
  const heldRoles = new Set(statuses.filter((s) => s.isActive).map((s) => s.role))

  function openStatus(status: JobStatus | 'new') {
    setEditing(status)
    if (status === 'new') {
      setName('')
      setTone('neutral')
      setRole('')
      setIsActive(true)
      // A new stage inherits nothing: no reason, the site setting for blocking,
      // open to anybody, and open. Every one of those is the safe answer.
      setRequiresReason(false)
      setBlocksOnIncomplete(null)
      setAudience('anyone')
      setIsClosedStage(false)
    } else {
      setName(status.name)
      setTone(status.tone)
      setRole(status.role)
      setIsActive(status.isActive)
      setRequiresReason(status.requiresReason)
      setBlocksOnIncomplete(status.blocksOnIncomplete)
      setAudience(status.audience)
      setIsClosedStage(status.isClosedStage)
    }
  }

  function saveStatus() {
    start(async () => {
      const result = await saveStatusAction({
        id: editing === 'new' || editing === null ? null : editing.id,
        name,
        tone,
        role,
        isActive,
        requiresReason,
        blocksOnIncomplete,
        audience,
        isClosedStage,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Status saved.')
      setEditing(null)
      router.refresh()
    })
  }

  function removeStatus(status: JobStatus) {
    start(async () => {
      const result = await deleteStatusAction(status.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${status.name} removed.`)
      router.refresh()
    })
  }

  function move(status: JobStatus, direction: -1 | 1) {
    const ordered = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder)
    const index = ordered.findIndex((s) => s.id === status.id)
    const swap = index + direction
    if (swap < 0 || swap >= ordered.length) return
    const next = [...ordered]
    ;[next[index], next[swap]] = [next[swap], next[index]]

    start(async () => {
      const result = await reorderStatusesAction(next.map((s) => s.id))
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      router.refresh()
    })
  }

  const ordered = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder)

  return (
    <>
      <Card>
        <CardHeader
          title="Stages"
          description="What a job moves through. Rename these to match what your team calls them — the system finds each one by its meaning, not its name."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openStatus('new')}
              disabled={pending}
            >
              <Icons.Plus size={14} />
              Add a stage
            </Button>
          }
        />
        <CardBody className="p-0">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Stage</th>
                <th className={TABLE_TH}>Means</th>
                <th className={TABLE_TH}>Open or closed</th>
                <th className={TABLE_TH}>Jobs</th>
                <th className={TABLE_TH} />
              </tr>
            </thead>
            <tbody>
              {ordered.map((status, index) => (
                <tr key={status.id}>
                  <td className={TABLE_TD}>
                    <div className="flex items-center gap-2">
                      <Badge tone={TONE[status.tone] ?? 'neutral'}>{status.name}</Badge>
                      {!status.isActive && <span className="text-xs text-muted">Off</span>}
                      {offBoard.has(status.id) && (
                        /* The trap, on the row that causes it. */
                        <span className="text-xs text-warning">On no board</span>
                      )}
                    </div>
                  </td>
                  <td className={TABLE_TD}>
                    {status.role ? (
                      <span className="text-ink-2">{ROLE_LABEL[status.role]}</span>
                    ) : (
                      <span className="text-faint">A stage of your own</span>
                    )}
                  </td>
                  <td className={TABLE_TD}>
                    {/* The role OR the stage flag — the same OR setStatus uses.
                        Reading only the role would have shown the new Closed
                        stage as Open, on the screen that configures it. */}
                    <span
                      className={
                        isClosed(status.role) || status.isClosedStage ? 'text-muted' : 'text-ink-2'
                      }
                    >
                      {isClosed(status.role) || status.isClosedStage ? 'Closed' : 'Open'}
                    </span>
                  </td>
                  <td className={TABLE_TD}>
                    <span className="numeric text-ink-2">{status.jobCount}</span>
                  </td>
                  <td className={TABLE_TD}>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Move ${status.name} earlier`}
                        disabled={pending || index === 0}
                        onClick={() => move(status, -1)}
                      >
                        <Icons.ChevronUp size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Move ${status.name} later`}
                        disabled={pending || index === ordered.length - 1}
                        onClick={() => move(status, 1)}
                      >
                        <Icons.ChevronDown size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openStatus(status)}
                        disabled={pending}
                      >
                        Edit
                      </Button>
                      {/* A system stage shows no delete at all rather than one
                          that refuses: the refusal is correct but offering it
                          invites the click. */}
                      {!status.isSystem && (
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Delete ${status.name}`}
                          disabled={pending}
                          onClick={() => removeStatus(status)}
                        >
                          <Icons.Trash size={14} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {/* ── Stage editor ──────────────────────────────────────────────── */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add a stage' : 'Edit stage'}
        size="sm"
        /* A long form: the default 60vh cap made it read through a letterbox with
           empty desktop above and below. Still a MAX, so a short one stays short. */
        bodyGrows
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" hint="What your team calls this stage.">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="On the bench"
            />
          </Field>

          <Field label="Colour" hint="Paired with the name everywhere, never used alone.">
            <Select value={tone} onChange={(e) => setTone(e.target.value as JobStatusTone)}>
              {TONES.map((value) => (
                <option key={value} value={value}>
                  {value === 'neutral'
                    ? 'Plain'
                    : value === 'brand'
                      ? 'Blue'
                      : value === 'success'
                        ? 'Green'
                        : value === 'warning'
                          ? 'Amber'
                          : 'Red'}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="What it means"
            hint="How the system finds this stage regardless of its name. Each meaning belongs to one stage."
          >
            <Select
              value={role}
              disabled={editing !== 'new' && editing !== null && editing.isSystem}
              onChange={(e) => setRole(e.target.value as JobStatusRole)}
            >
              <option value="">A stage of your own</option>
              {REQUIRED_ROLES.map((value) => (
                <option
                  key={value}
                  value={value}
                  disabled={
                    heldRoles.has(value) &&
                    !(editing !== 'new' && editing !== null && editing.role === value)
                  }
                >
                  {ROLE_LABEL[value]}
                  {heldRoles.has(value) &&
                  !(editing !== 'new' && editing !== null && editing.role === value)
                    ? ' — already taken'
                    : ''}
                </option>
              ))}
            </Select>
          </Field>

          {/* ── The rules for this stage (10.1) ────────────────────────────
              Per stage rather than one global switch, because the closing
              stages want opposite answers: Work Completed must demand its
              checks, Cancelled must not. */}
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Rules for this stage
            </p>

            <Switch
              checked={requiresReason}
              onChange={setRequiresReason}
              label="Ask why when a job is moved here"
              hint="Worth it for Paused or On Hold. A stage that needs a reason cannot be reached by dragging a card, because a drag carries no sentence."
            />

            <Field
              label="Outstanding tasks and checks"
              hint="Only applies to stages that close a job."
            >
              <Select
                value={blocksOnIncomplete === null ? '' : blocksOnIncomplete ? '1' : '0'}
                onChange={(e) =>
                  setBlocksOnIncomplete(e.target.value === '' ? null : e.target.value === '1')
                }
              >
                <option value="">Follow the job setting</option>
                <option value="1">Must be done first</option>
                <option value="0">Do not stop the move</option>
              </Select>
            </Field>

            <Field label="Who may move a job here">
              <Select
                value={audience}
                onChange={(e) => setAudience(e.target.value as 'anyone' | 'office')}
              >
                <option value="anyone">Anybody who may edit a job</option>
                <option value="office">Only somebody who bills jobs</option>
              </Select>
            </Field>

            {/* Hidden for a stage that already carries a closing meaning: the
                role wins, and offering a switch that changes nothing is worse
                than not offering it. */}
            {role !== 'completed' && role !== 'cancelled' && (
              <Switch
                checked={isClosedStage}
                onChange={setIsClosedStage}
                label="A job here counts as closed"
                hint="Takes it off the open list and out of every open-jobs figure."
              />
            )}
          </div>

          {editing !== 'new' && editing !== null && editing.isSystem && (
            <p className="text-xs text-muted">
              This stage carries a meaning the system needs, so its name and colour can change but
              its meaning cannot, and it cannot be switched off or deleted.
            </p>
          )}

          {!(editing !== 'new' && editing !== null && editing.isSystem) && (
            <Checkbox
              label="In use — jobs can be moved here"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveStatus} disabled={pending || !name.trim()}>
              Save stage
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
