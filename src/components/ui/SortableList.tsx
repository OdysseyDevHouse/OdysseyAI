'use client'

import { useId, useState, type ReactNode } from 'react'
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { DragHandle } from './icons'

/**
 * A list whose rows are reordered by dragging.
 *
 * ── WHY THIS IS A KIT COMPONENT ───────────────────────────────────────────
 *
 * Two screens wanted the same thing on the same day — tender types and
 * specials — and both were about to grow their own DndContext, their own
 * sensors and their own handle. That is three copies of the hydration trap
 * below waiting to be got wrong twice.
 *
 * ── WHAT IT REPLACES ──────────────────────────────────────────────────────
 *
 * A pair of up/down arrows per row. Those work, and they are keyboard- and
 * screen-reader-friendly in a way a drag is not by default — which is why the
 * handle here carries the keyboard sensor: focus it and the arrow keys move
 * the row, so nothing is lost by dropping the buttons.
 *
 * ── THE ONE THING THAT BREAKS ─────────────────────────────────────────────
 *
 * dnd-kit derives its aria ids from a module counter that the server restarts
 * at 0, so an unnamed DndContext is a hydration mismatch on every load. `useId`
 * gives it a stable one per instance. The menu designer documents this at
 * length; this component exists partly so nobody has to learn it a third time.
 */
export function SortableList<T>({
  items,
  getId,
  onReorder,
  disabled = false,
  children,
  className = 'flex flex-col',
}: {
  items: T[]
  /** Stable identity per row. Must not change while a drag is in flight. */
  getId: (item: T) => string | number
  /**
   * The new order, once a row is dropped somewhere new.
   *
   * Called with the whole list rather than a from/to pair: every caller so far
   * sends the full order to a server action, and computing it here means one
   * `arrayMove` rather than one per screen.
   */
  onReorder: (next: T[]) => void
  /**
   * Switches dragging off — for a list that is filtered, or mid-save.
   *
   * Filtering is the case worth naming: reordering a FILTERED list moves a row
   * past rows nobody can see, so a screen that offers a filter must disable
   * this while one is on. Rows still render; only the handle goes quiet.
   */
  disabled?: boolean
  /** One row. `handle` must be rendered somewhere inside it, or it cannot move. */
  children: (item: T, handle: ReactNode) => ReactNode
  className?: string
}) {
  const id = useId()

  /* A small distance before a drag begins, so a click on a button inside a row
     is still a click. Without it every press on Edit starts a drag that eats
     the click. Touch waits instead: a finger that has not moved in 200ms is
     holding, not scrolling. */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    /* `over` is null when a row is dropped outside the list, and equal to
       `active` when it is dropped back where it started. Neither is a reorder,
       and calling the action for either would write the order it already has. */
    if (!over || active.id === over.id) return
    const from = items.findIndex((item) => String(getId(item)) === String(active.id))
    const to = items.findIndex((item) => String(getId(item)) === String(over.id))
    if (from === -1 || to === -1) return
    onReorder(arrayMove(items, from, to))
  }

  return (
    <DndContext id={id} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext
        items={items.map((item) => String(getId(item)))}
        strategy={verticalListSortingStrategy}
      >
        <div className={className}>
          {items.map((item) => (
            <SortableRow key={getId(item)} id={String(getId(item))} disabled={disabled}>
              {(handle) => children(item, handle)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

/** One row, and the handle that moves it. */
function SortableRow({
  id,
  disabled,
  children,
}: {
  id: string
  disabled: boolean
  children: (handle: ReactNode) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled })

  const handle = (
    /* Not a kit Button: a drag handle is an activator that must carry dnd-kit's
       own listeners and ref, and Button's own onClick/type would fight them.
       It is still a real <button>, so it takes focus and the keyboard sensor
       moves the row with the arrow keys. */
    <button
      ref={setActivatorNodeRef}
      type="button"
      data-kit-ok
      disabled={disabled}
      aria-label="Drag to reorder"
      className={`flex size-7 shrink-0 items-center justify-center rounded-control text-faint transition ${
        disabled
          ? 'cursor-not-allowed opacity-40'
          : 'cursor-grab hover:bg-surface-2 hover:text-muted active:cursor-grabbing'
      }`}
      {...attributes}
      {...listeners}
    >
      <DragHandle size={15} />
    </button>
  )

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      /* Lifted while it moves, so it reads as one row travelling over the
         others rather than the list rearranging around a gap. */
      className={isDragging ? 'relative z-10 shadow-pop' : undefined}
    >
      {children(handle)}
    </div>
  )
}
