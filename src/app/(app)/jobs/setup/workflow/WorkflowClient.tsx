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
import type { JobBoard, JobBoardLayout } from '@/lib/site/jobBoards'
import {
  REQUIRED_ROLES,
  ROLE_LABEL,
  isClosed,
  type JobStatusRole,
  type JobStatusTone,
} from '@/lib/jobStatusModel'
import {
  saveStatusAction,
  deleteStatusAction,
  reorderStatusesAction,
  saveBoardAction,
  deleteBoardAction,
} from '../../actions'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

const TONES: JobStatusTone[] = ['neutral', 'brand', 'success', 'warning', 'danger']

/**
 * Configuring the workflow.
 *
 * Two cards, because they are two jobs: what the stages ARE, and which of them a
 * given board shows. Merging them into one grid would suggest a status belongs to
 * a board, which is the exact model this module rejected — a board holds no jobs
 * and a status belongs to no board.
 *
 * Reordering is buttons rather than drag-and-drop. The list is eight rows set once
 * a year, and a drag surface here would cost a dnd context, a sensor set and a
 * keyboard story to save two clicks on a screen nobody opens twice.
 */
export default function WorkflowClient({
  statuses,
  boards,
  columnsByBoard,
  offBoardIds,
}: {
  statuses: JobStatus[]
  boards: JobBoard[]
  columnsByBoard: Record<number, number[]>
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

  const [board, setBoard] = useState<JobBoard | 'new' | null>(null)
  const [boardName, setBoardName] = useState('')
  const [boardLayout, setBoardLayout] = useState<JobBoardLayout>('kanban')
  const [boardActive, setBoardActive] = useState(true)
  const [boardColumns, setBoardColumns] = useState<number[]>([])

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

  function openBoard(target: JobBoard | 'new') {
    setBoard(target)
    if (target === 'new') {
      setBoardName('')
      setBoardLayout('kanban')
      setBoardActive(true)
      // A new board starts showing every OPEN stage: that is what somebody
      // setting one up almost always wants, and unticking is quicker than
      // ticking eight boxes.
      // A new board opens with the OPEN stages ticked, so closing stages —
      // however they are marked closed — do not clutter it by default.
      setBoardColumns(
        statuses
          .filter((s) => s.isActive && !isClosed(s.role) && !s.isClosedStage)
          .map((s) => s.id),
      )
    } else {
      setBoardName(target.name)
      setBoardLayout(target.layout)
      setBoardActive(target.isActive)
      setBoardColumns(columnsByBoard[target.id] ?? [])
    }
  }

  function saveBoard() {
    start(async () => {
      const result = await saveBoardAction({
        id: board === 'new' || board === null ? null : board.id,
        name: boardName,
        layout: boardLayout,
        isActive: boardActive,
        statusIds: boardColumns,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Board saved.')
      setBoard(null)
      router.refresh()
    })
  }

  function removeBoard(target: JobBoard) {
    start(async () => {
      const result = await deleteBoardAction(target.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`${target.name} removed.`)
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
            <Button variant="secondary" size="sm" onClick={() => openStatus('new')} disabled={pending}>
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
                      <Button variant="ghost" size="sm" onClick={() => openStatus(status)} disabled={pending}>
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

      <Card>
        <CardHeader
          title="Boards"
          description="A board is a view over the stages you choose. A job appears on every board that shows its stage, so the same job can be on more than one."
          action={
            <Button variant="secondary" size="sm" onClick={() => openBoard('new')} disabled={pending}>
              <Icons.Plus size={14} />
              Add a board
            </Button>
          }
        />
        <CardBody className="p-0">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Board</th>
                <th className={TABLE_TH}>Shows</th>
                <th className={TABLE_TH}>Layout</th>
                <th className={TABLE_TH} />
              </tr>
            </thead>
            <tbody>
              {boards.map((item) => (
                <tr key={item.id}>
                  <td className={TABLE_TD}>
                    <span className="text-ink">{item.name}</span>
                    {!item.isActive && <span className="ml-2 text-xs text-muted">Off</span>}
                  </td>
                  <td className={TABLE_TD}>
                    <span className="text-ink-2">
                      {item.columnCount} {item.columnCount === 1 ? 'stage' : 'stages'}
                    </span>
                  </td>
                  <td className={TABLE_TD}>
                    <span className="text-ink-2">{item.layout === 'kanban' ? 'Board' : 'Grouped list'}</span>
                  </td>
                  <td className={TABLE_TD}>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openBoard(item)} disabled={pending}>
                        Edit
                      </Button>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Delete ${item.name}`}
                        disabled={pending}
                        onClick={() => removeBoard(item)}
                      >
                        <Icons.Trash size={14} />
                      </Button>
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
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="On the bench" />
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

      {/* ── Board editor ──────────────────────────────────────────────── */}
      <Modal
        open={board !== null}
        onClose={() => setBoard(null)}
        title={board === 'new' ? 'Add a board' : 'Edit board'}
        size="md"
      >
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <Input
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              placeholder="Workshop"
            />
          </Field>

          <Field label="Layout" hint="Both read the same jobs — one as columns, one as a grouped list.">
            <Select value={boardLayout} onChange={(e) => setBoardLayout(e.target.value as JobBoardLayout)}>
              <option value="kanban">Board — columns you drag between</option>
              <option value="grid">Grouped list — better on a wall display</option>
            </Select>
          </Field>

          <Field
            label="Which stages it shows"
            hint="Every job in a ticked stage appears on this board. A stage can be on several boards."
          >
            <div className="flex flex-col gap-1.5">
              {ordered
                .filter((s) => s.isActive)
                .map((status) => (
                  <Checkbox
                    key={status.id}
                    label={
                      <>
                        {status.name}
                        {isClosed(status.role) && (
                          <span className="ml-1.5 text-xs text-muted">(closed)</span>
                        )}
                      </>
                    }
                    checked={boardColumns.includes(status.id)}
                    onChange={(e) =>
                      setBoardColumns((current) =>
                        e.target.checked
                          ? [...current, status.id]
                          : current.filter((id) => id !== status.id),
                      )
                    }
                  />
                ))}
            </div>
          </Field>

          <Checkbox
            label="In use — appears in the board picker"
            checked={boardActive}
            onChange={(e) => setBoardActive(e.target.checked)}
          />

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setBoard(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={saveBoard}
              disabled={pending || !boardName.trim() || boardColumns.length === 0}
            >
              Save board
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
