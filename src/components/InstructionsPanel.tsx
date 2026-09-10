'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { Badge, Button, EmptyState, Tooltip } from '@/components/ui'
import { Close, DragHandle, Plus } from '@/components/ui/icons'
import type { InstructionGroup } from '@/lib/site/instructions'

/**
 * Which instructions this product asks when it is sold, and in what order.
 *
 * The groups themselves are a shared library managed under Inventory →
 * Instructions; this only decides which of them attach to this product. Editing
 * an option lives there too, so the same bread list serves every sandwich.
 *
 * ── WHY THIS IS TWO LISTS AND NOT A COLUMN OF TICK BOXES ──────────────────
 *
 * It was tick boxes, and `setGroupsForProduct` has always written the submitted
 * array's index into `product_instruction_groups.sort_order`. But a checkbox
 * list submits in LIBRARY order, so that index recorded nothing anybody chose —
 * a breakfast asked about bread before eggs because "bread" sorts first, and
 * there was no way to say otherwise. The column existed and was meaningless.
 *
 * Splitting the two states is what gives it meaning: the attached list IS the
 * order, top to bottom, and dragging within it is the gesture that sets it.
 *
 * Ticked ids submit as instructionGroup[] in that order; the action replaces the
 * product's whole set, so anything moved back to "available" is detached.
 */

function choiceRule(min: number, max: number): string {
  if (max === 1) return min > 0 ? 'Pick one' : 'Pick one (optional)'
  if (max === 0) return min > 0 ? `Choose at least ${min}` : 'Choose any number'
  if (min > 0 && min !== max) return `Choose ${min} to ${max}`
  if (min > 0 && min === max) return `Choose exactly ${min}`
  return `Choose up to ${max}`
}

function summary(g: InstructionGroup): string {
  const rule = choiceRule(g.minChoices, g.maxChoices)
  const options = `${g.optionCount} option${g.optionCount === 1 ? '' : 's'}`
  return g.prompt ? `${g.prompt} · ${rule} · ${options}` : `${rule} · ${options}`
}

export default function InstructionsPanel({
  groups,
  attached,
  onManage,
}: {
  /** Every active instruction in the library. */
  groups: InstructionGroup[]
  /** Ids currently attached to this product, in the order it asks them. */
  attached: number[]
  /**
   * Opens the library dialog — creating a question and changing its answers,
   * without leaving the product and losing what is unsaved on it.
   *
   * Optional, because the dialog needs a place OUTSIDE the product <form> to
   * render and only the product screen has one. A caller that has nowhere to
   * put it gets the panel it always had.
   */
  onManage?: () => void
}) {
  const byId = new Map(groups.map((g) => [g.id, g]))

  // Seeded from `attached` so the saved order is what shows. Ids whose group has
  // since been deleted are dropped rather than rendered as a gap.
  const [selected, setSelected] = useState<number[]>(() =>
    attached.filter((id) => byId.has(id)),
  )

  const dragIdRef = useRef<number | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)

  const attach = (id: number) => setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]))
  const detach = (id: number) => setSelected((prev) => prev.filter((x) => x !== id))

  const move = (targetId: number) => {
    const from = dragIdRef.current
    setDragId(null)
    setOverId(null)
    dragIdRef.current = null
    if (from === null || from === targetId) return

    setSelected((prev) => {
      const fromIndex = prev.indexOf(from)
      const toIndex = prev.indexOf(targetId)
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev

      // Spliced out first, so the destination is found again in the shortened
      // array — otherwise a downward drag lands one slot short.
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      const insertAt = next.indexOf(targetId)
      next.splice(fromIndex < toIndex ? insertAt + 1 : insertAt, 0, moved)
      return next
    })
  }

  if (groups.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No instructions set up yet"
          hint={
            onManage
              ? 'Create one — for example “Choice of bread” with white, brown and rye — then attach it here.'
              : 'Create one under Inventory → Instructions — for example “Choice of bread” — then attach it here.'
          }
          action={
            onManage && (
              <Button type="button" variant="primary" size="sm" onClick={onManage}>
                <Plus size={14} />
                New instruction
              </Button>
            )
          }
        />
      </div>
    )
  }

  /* Inactive groups are not offered, because attaching one asks nothing at the
     till. An inactive group ALREADY attached still renders above, with its
     badge — switching a question off is not the same as taking it off the
     products that ask it, and this list must not quietly do the second. */
  const available = groups.filter((g) => !selected.includes(g.id) && g.isActive)

  return (
    <div className="flex flex-col gap-6 p-6">
      <p className="text-sm text-muted">
        Questions the till asks when this product is sold, in the order it asks them. Instructions
        are shared across products
        {onManage ? (
          <>
            {' '}
            — <span className="font-medium text-ink-2">Manage instructions</span> above changes a
            question and its answers for every product that asks it. Stock links, pictures and
            follow-on questions live on the full editor under{' '}
          </>
        ) : (
          <> — edit the options themselves under </>
        )}
        <Link href="/instructions" className="text-brand hover:underline">
          Inventory → Instructions
        </Link>
        .
      </p>

      {/* ── Attached, in order ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-ink">
          Asked by this product
          {selected.length > 1 && (
            <span className="ml-2 text-xs font-normal text-muted">drag to reorder</span>
          )}
        </h3>

        {selected.length === 0 ? (
          <p className="rounded-control border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
            None yet. Add one from below.
          </p>
        ) : (
          selected.map((id, i) => {
            const g = byId.get(id)
            if (!g) return null
            return (
              <div
                key={g.id}
                /* Not a kit component: a full-width ordered row with a nested
                   description and a drag affordance, which no kit row expresses.
                   data-kit-ok */
                data-kit-ok
                onDragOver={(e) => {
                  if (dragIdRef.current === null) return
                  // Must preventDefault on EVERY dragover or the drop is refused.
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (overId !== g.id) setOverId(g.id)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  move(g.id)
                }}
                onDragEnd={() => {
                  dragIdRef.current = null
                  setDragId(null)
                  setOverId(null)
                }}
                className={`flex items-start gap-3 rounded-control border px-4 py-3 transition ${
                  overId === g.id && dragId !== g.id ? 'border-brand' : 'border-border'
                } ${dragId === g.id ? 'opacity-40' : ''}`}
              >
                {/* Only the handle starts the drag — see the note in
                    InstructionForm's answer rows. */}
                <Tooltip
                  label={selected.length > 1 ? 'Drag to reorder' : 'Add another to reorder'}
                  layout="inline"
                  className="mt-0.5"
                >
                  <span
                    draggable={selected.length > 1}
                    onDragStart={(e) => {
                      dragIdRef.current = g.id
                      setDragId(g.id)
                      // Firefox will not start a drag without data on the transfer.
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(g.id))
                    }}
                    aria-hidden
                    className={`text-faint ${selected.length > 1 ? 'cursor-grab hover:text-muted' : 'opacity-30'}`}
                  >
                    <DragHandle size={15} />
                  </span>
                </Tooltip>

                {/* The position, so the order is readable without counting. */}
                <span className="mt-0.5 w-4 shrink-0 text-xs text-muted numeric">{i + 1}</span>

                {/* Submitted in THIS order, which is what makes the order real. */}
                <input type="hidden" name="instructionGroup" value={g.id} />

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{g.name}</span>
                    {g.isRequired && <Badge tone="warning">required</Badge>}
                    {!g.isActive && <Badge>inactive</Badge>}
                    {g.optionCount === 0 && <Badge tone="danger">0 options</Badge>}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{summary(g)}</span>
                </span>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Stop asking ${g.name}`}
                  onClick={() => detach(g.id)}
                >
                  <Close size={14} />
                </Button>
              </div>
            )
          })
        )}
      </div>

      {/* ── The rest of the library ────────────────────────────────────────── */}
      {available.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">Available</h3>
          {available.map((g) => (
            <div
              key={g.id}
              /* Same shape as an attached row, minus the ordering affordances.
                 data-kit-ok */
              data-kit-ok
              className="flex items-start gap-3 rounded-control border border-border px-4 py-3 transition hover:border-brand/50"
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{g.name}</span>
                  {g.isRequired && <Badge tone="warning">required</Badge>}
                  {!g.isActive && <Badge>inactive</Badge>}
                </span>
                <span className="mt-0.5 block text-xs text-muted">{summary(g)}</span>
              </span>

              <Button type="button" variant="secondary" size="sm" onClick={() => attach(g.id)}>
                <Plus size={14} />
                Ask this
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
