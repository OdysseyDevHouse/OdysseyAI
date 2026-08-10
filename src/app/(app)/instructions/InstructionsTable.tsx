'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, DragHandle } from '@/components/ui/icons'
import {
  Badge,
  EmptyState,
  PrimaryLink,
  TextLink,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TH,
  useToast,
} from '@/components/ui'
import type { listGroups } from '@/lib/site/instructions'
import { reorderInstructionsAction } from './actions'

/**
 * The instruction-groups table.
 *
 * ── WHY THIS IS NOT A DataTable ───────────────────────────────────────────
 *
 * It was, until the order became something a shop can set. DataTable sorts its
 * own rows by whichever column the user clicked, which is exactly the wrong
 * behaviour for a list whose order IS the data — a drag would move a row and
 * the table would immediately re-sort it back. So the rows are laid out by hand
 * wearing the shared table skin, the same trade DepartmentsClient makes for the
 * same reason.
 */

/** "Pick one", "Choose up to 3", "Choose 2 to 4" — the rule in plain words. */
function choiceRule(min: number, max: number): string {
  if (max === 1) return min > 0 ? 'Pick one' : 'Pick one (optional)'
  if (max === 0) return min > 0 ? `Choose at least ${min}` : 'Choose any number'
  if (min > 0 && min !== max) return `Choose ${min} to ${max}`
  if (min > 0 && min === max) return `Choose exactly ${min}`
  return `Choose up to ${max}`
}

type GroupRow = Awaited<ReturnType<typeof listGroups>>[number]

export function InstructionsTable({
  rows,
  canEdit = false,
}: {
  rows: GroupRow[]
  /** Dragging is offered only to someone who could save the result. */
  canEdit?: boolean
}) {
  const router = useRouter()
  const toast = useToast()

  const [order, setOrder] = useState<GroupRow[]>(rows)
  const [busy, setBusy] = useState(false)

  // The id in a ref as well as in state: dragover fires far faster than React
  // re-renders, and reading the state there would read a stale value.
  const dragIdRef = useRef<number | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)

  async function handleDrop(targetId: number) {
    const draggedId = dragIdRef.current
    setOverId(null)
    setDragId(null)
    dragIdRef.current = null
    if (draggedId === null || draggedId === targetId) return

    const from = order.findIndex((g) => g.id === draggedId)
    const to = order.findIndex((g) => g.id === targetId)
    if (from < 0 || to < 0 || from === to) return

    // Dropping ON a row means "take that row's place". The dragged row is
    // spliced out FIRST, so every later index shifts down by one and the
    // destination has to be found again in the shortened array — otherwise a
    // downward drag lands one slot short and appears to do nothing.
    const next = [...order]
    const [moved] = next.splice(from, 1)
    const insertAt = next.findIndex((g) => g.id === targetId)
    next.splice(from < to ? insertAt + 1 : insertAt, 0, moved)

    const previous = order
    setOrder(next)
    setBusy(true)
    try {
      const result = await reorderInstructionsAction(next.map((g) => g.id))
      if (!result.ok) {
        setOrder(previous)
        toast.error(result.error ?? 'That did not work.')
        return
      }
      router.refresh()
    } catch {
      setOrder(previous)
      toast.error('That did not work.')
    } finally {
      setBusy(false)
    }
  }

  if (order.length === 0) {
    return (
      <EmptyState
        title="No instructions yet"
        hint="Create one — for example “Choice of bread” with white, brown and rye — then attach it to the products that should ask it."
        action={
          <PrimaryLink href="/instructions/new">
            <Plus size={15} />
            New instruction
          </PrimaryLink>
        }
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            {canEdit && <th className={`${TABLE_TH} w-px`} />}
            <th className={TABLE_TH}>Instruction</th>
            <th className={TABLE_TH}>Rule</th>
            <th className={`${TABLE_TH} text-right`}>Options</th>
            <th className={`${TABLE_TH} text-right`}>Products</th>
            <th className={TABLE_TH}>{busy ? 'Saving…' : 'Status'}</th>
          </tr>
        </thead>
        <tbody>
          {order.map((g) => (
            <tr
              key={g.id}
              draggable={canEdit}
              onDragStart={(e) => {
                dragIdRef.current = g.id
                setDragId(g.id)
                // Firefox will not start a drag without data on the transfer.
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', String(g.id))
              }}
              onDragOver={(e) => {
                if (dragIdRef.current === null) return
                // Must preventDefault on EVERY dragover or the drop is refused.
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (overId !== g.id) setOverId(g.id)
              }}
              onDrop={(e) => {
                e.preventDefault()
                void handleDrop(g.id)
              }}
              onDragEnd={() => {
                dragIdRef.current = null
                setDragId(null)
                setOverId(null)
              }}
              className={`${TABLE_ROW} ${dragId === g.id ? 'opacity-40' : ''} ${
                overId === g.id && dragId !== g.id ? 'border-t-2 border-t-brand' : ''
              }`}
            >
              {canEdit && (
                <td className={`${TABLE_TD} cursor-grab text-faint`}>
                  <DragHandle size={15} aria-hidden />
                </td>
              )}

              <td className={TABLE_TD}>
                <TextLink href={`/instructions/${g.id}`}>{g.name}</TextLink>
                {g.prompt && <span className="block text-xs text-muted">{g.prompt}</span>}
              </td>

              <td className={TABLE_TD}>
                <span className="text-muted">
                  {choiceRule(g.minChoices, g.maxChoices)}
                  {/* Neutral, not warning: required is a configuration, not a problem. */}
                  {g.isRequired && <Badge className="ml-2">Required</Badge>}
                </span>
              </td>

              {/* A question with no answers is broken — the till has nothing to show. */}
              <td className={`${TABLE_TD} text-right`}>
                {g.optionCount === 0 ? <Badge tone="danger">0 options</Badge> : g.optionCount}
              </td>

              <td className={`${TABLE_TD} text-right`}>
                {g.productCount > 0 ? (
                  <span className="text-muted">{g.productCount}</span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>

              {/* Active is the normal state; only the exception wears a badge. */}
              <td className={TABLE_TD}>{g.isActive ? null : <Badge>Inactive</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {canEdit && (
        <p className="px-4 py-3 text-xs text-muted">
          Drag a row to change the order. This is the order a till asks the questions in when a
          product has more than one.
        </p>
      )}
    </div>
  )
}
