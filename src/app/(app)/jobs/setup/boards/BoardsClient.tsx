'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Select,
  Modal,
  Icons,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
} from '@/components/ui'
import type { JobStatus } from '@/lib/site/jobStatuses'
import type { JobBoard, JobBoardLayout } from '@/lib/site/jobBoards'
import { isClosed } from '@/lib/jobStatusModel'
import { saveBoardAction, deleteBoardAction } from '../../actions'

/**
 * The views a team works from.
 *
 * ── THE STAGES ARRIVE READ-ONLY, AND THAT IS THE POINT ─────────────────────
 *
 * This screen ticks stages; it cannot create, rename or reorder one. That
 * asymmetry is the model made visible: a board is a VIEW over stages that exist
 * independently of it, so a stage removed from every board still holds its jobs
 * and a board deleted takes no stage with it.
 *
 * Boards and stages shared one component and one route until this split, which
 * quietly suggested the opposite — that a stage was something a board owned.
 */
export default function BoardsClient({
  boards,
  statuses,
  columnsByBoard,
}: {
  boards: JobBoard[]
  /** Every stage, to tick. Read-only here — /jobs/setup/statuses owns them. */
  statuses: JobStatus[]
  columnsByBoard: Record<number, number[]>
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [board, setBoard] = useState<JobBoard | 'new' | null>(null)
  const [boardName, setBoardName] = useState('')
  const [boardLayout, setBoardLayout] = useState<JobBoardLayout>('kanban')
  const [boardActive, setBoardActive] = useState(true)
  const [boardColumns, setBoardColumns] = useState<number[]>([])

  const ordered = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder)

  function openBoard(target: JobBoard | 'new') {
    setBoard(target)
    if (target === 'new') {
      setBoardName('')
      setBoardLayout('kanban')
      setBoardActive(true)
      // A new board opens with the OPEN stages ticked, so closing stages —
      // however they are marked closed — do not clutter it by default. That is
      // what somebody setting one up almost always wants, and unticking is
      // quicker than ticking eight boxes.
      setBoardColumns(
        ordered
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

  return (
    <>
      <Card>
        <CardHeader
          title="Boards"
          description="A board is a view over the stages you choose. A job appears on every board that shows its stage, so the same job can be on more than one."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openBoard('new')}
              disabled={pending}
            >
              <Icons.Plus size={14} />
              Add a board
            </Button>
          }
        />
        <CardBody className={boards.length === 0 ? undefined : 'p-0'}>
          {boards.length === 0 ? (
            <EmptyState
              title="No boards yet"
              hint="A board is how your team sees its work — columns to drag between, or a grouped list for a wall display. Without one, jobs are only reachable from the job list."
              action={
                <Button variant="primary" size="sm" onClick={() => openBoard('new')}>
                  <Icons.Plus size={14} />
                  Add a board
                </Button>
              }
            />
          ) : (
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
                      <span className="text-ink-2">
                        {item.layout === 'kanban' ? 'Board' : 'Grouped list'}
                      </span>
                    </td>
                    <td className={TABLE_TD}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openBoard(item)}
                          disabled={pending}
                        >
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
          )}
        </CardBody>
      </Card>

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

          <Field
            label="Layout"
            hint="Both read the same jobs — one as columns, one as a grouped list."
          >
            <Select
              value={boardLayout}
              onChange={(e) => setBoardLayout(e.target.value as JobBoardLayout)}
            >
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
