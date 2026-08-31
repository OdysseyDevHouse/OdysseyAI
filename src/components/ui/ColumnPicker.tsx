'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ColumnsIcon, Check, DragHandle } from './icons'
import { buttonClass, type ButtonSize } from './styles'

/**
 * Which columns a wide table shows.
 *
 * A grid that has to carry twenty columns — the purchasing line grids, where a
 * buyer wants cost, markup, GP and selling price at once but a receiver wants
 * quantity and nothing else — cannot show them all and stay readable. This is
 * the control that lets one table serve both.
 *
 * ── WHY NOT <Menu> ────────────────────────────────────────────────────────
 *
 * Menu closes on any click inside it, which is right for a list of actions and
 * wrong here: choosing columns is a multi-select, and closing after each one
 * would mean reopening the menu for every column. So this owns its own panel.
 * The outside-click, Escape and aria wiring is the same as Menu's — deliberately
 * kept identical rather than shared, because the one behaviour that differs is
 * the reason this exists.
 *
 * Locked columns are the ones a table cannot be read without: the item on a
 * purchase line, the quantity being received. They are shown with their box
 * ticked and disabled, rather than hidden from the list — a user looking for
 * "Item" should find it and see that it is always on, not wonder where it went.
 */

export type ColumnOption = {
  /** Matches the key held in the visible set. */
  id: string
  label: string
  /** Always shown, and not switchable off. */
  locked?: boolean
  /** Groups entries under a heading — 'Cost', 'Pricing', 'Stock'. */
  group?: string
}

/**
 * One row of the orderable list: a drag handle, a tick box, and the label.
 *
 * The handle is a separate target rather than the whole row being draggable,
 * because the row is already a checkbox — a pointer-down that might be either a
 * tick or the start of a drag has to guess, and it guesses wrong on a tap.
 */
function SortableRow({
  column,
  on,
  onToggle,
}: {
  column: ColumnOption
  on: boolean
  onToggle: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-1 rounded-[6px] pr-1 transition ${
        isDragging ? 'relative z-10 bg-surface-2 shadow-pop' : 'hover:bg-surface-2'
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Move ${column.label}`}
        className="cursor-grab touch-none px-1 py-1.5 text-faint transition hover:text-muted active:cursor-grabbing"
      >
        <DragHandle size={14} />
      </button>

      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        disabled={column.locked}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[6px] py-1.5 pr-1.5 text-left text-sm text-ink-2 transition disabled:pointer-events-none disabled:text-faint"
      >
        {/* Drawn to the checkbox's own size rather than the kit <Checkbox>:
            this row is the control, so the box must not also be separately
            clickable inside it. data-kit-ok */}
        <span
          data-kit-ok
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition ${
            on ? 'border-brand bg-brand text-white' : 'border-border-strong bg-surface'
          }`}
        >
          {on && <Check size={12} />}
        </span>
        <span className="truncate">{column.label}</span>
      </button>
    </div>
  )
}

export function ColumnPicker({
  columns,
  visible,
  onChange,
  onReset,
  onReorder,
  order,
  label = 'Columns',
  align = 'right',
  size = 'md',
}: {
  columns: readonly ColumnOption[]
  /** The ids currently shown. Locked ids need not be in here. */
  visible: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  /** Offered as "Reset" when given — restores the table's own default set. */
  onReset?: () => void
  /**
   * Given when the columns may be REORDERED as well as switched on and off.
   *
   * Reordering and grouping are mutually exclusive, so supplying this switches
   * the panel to one flat list in render order: a heading like "Pricing" is a
   * claim about where a column sits, and a list that lets you drag a column out
   * of its group while still showing the heading above it is lying about one of
   * the two. The flat list is the honest shape once order is the point.
   */
  onReorder?: (nextOrder: string[]) => void
  /**
   * The current render order, ids first-to-last. Only read when `onReorder` is
   * given. Ids missing from it fall to the end in catalogue order, so a column
   * added in a later release appears without needing a stored order to mention
   * it.
   */
  order?: readonly string[]
  label?: string
  align?: 'left' | 'right'
  /**
   * Trigger height, matching Button/Menu.
   *
   * `md` (40px) is the default and the height this button should normally take.
   * It sits in a toolbar beside full-height controls — a period Select, an
   * Export menu — and a shorter button in that row reads as misaligned rather
   * than as deliberately smaller. A 32px Columns button is never wanted.
   */
  size?: ButtonSize
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function toggle(id: string) {
    const next = new Set(visible)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    /* Long-press before a drag starts, so the panel can still be SCROLLED with
       a finger — the list is taller than the panel on most reports. */
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )

  /*
   * The flat list, in render order, for the orderable mode.
   *
   * `order` first, then anything it does not mention in catalogue order — so a
   * column added in a later release appears at the end rather than vanishing
   * because a set stored last year has never heard of it.
   */
  const ordered = useMemo(() => {
    if (!onReorder) return []
    const byId = new Map(columns.map((c) => [c.id, c]))
    const out: ColumnOption[] = []
    for (const id of order ?? []) {
      const col = byId.get(id)
      if (col) {
        out.push(col)
        byId.delete(id)
      }
    }
    for (const col of columns) if (byId.has(col.id)) out.push(col)
    return out
  }, [columns, order, onReorder])

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const ids = ordered.map((c) => c.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return

    ids.splice(to, 0, ...ids.splice(from, 1))
    onReorder?.(ids)
  }

  // Insertion-ordered, so the panel follows the order the table declares its
  // columns in rather than an alphabetical one nobody asked for.
  const groups = new Map<string, ColumnOption[]>()
  for (const column of columns) {
    const key = column.group ?? ''
    const list = groups.get(key)
    if (list) list.push(column)
    else groups.set(key, [column])
  }

  const shown = columns.filter((c) => c.locked || visible.has(c.id)).length

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={buttonClass({ variant: 'ghost', size })}
      >
        <ColumnsIcon size={15} />
        {label}
        <span className="numeric text-muted">{shown}</span>
      </button>

      {open && (
        <div
          id={panelId}
          /* A dialog, not a menu: menu semantics promise that activating an
             item performs an action and closes, and these are checkboxes. */
          role="dialog"
          aria-label="Choose columns"
          className={`absolute z-20 mt-1.5 max-h-[60vh] w-60 overflow-y-auto rounded-control border border-border bg-surface p-1 shadow-pop ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {onReorder ? (
            /* Ordered mode: one flat list, no group headings — see `onReorder`.
               The context id is fixed because dnd-kit derives aria ids from a
               module counter the server restarts at 0, so an unnamed context is
               a hydration mismatch on every load. */
            <DndContext
              id="column-picker"
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={ordered.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                {ordered.map((column) => (
                  <SortableRow
                    key={column.id}
                    column={column}
                    on={column.locked || visible.has(column.id)}
                    onToggle={() => toggle(column.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
          [...groups.entries()].map(([group, entries]) => (
            <div key={group}>
              {group && (
                <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted">{group}</p>
              )}
              {entries.map((column) => {
                const on = column.locked || visible.has(column.id)
                return (
                  <button
                    key={column.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={column.locked}
                    onClick={() => toggle(column.id)}
                    className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-1.5 text-left text-sm text-ink-2 transition hover:bg-surface-2 disabled:pointer-events-none disabled:text-faint"
                  >
                    {/* A tick box drawn to the checkbox's own size rather than
                        the kit <Checkbox>: this row is the control, so the box
                        must not also be separately clickable inside it.
                        data-kit-ok */}
                    <span
                      data-kit-ok
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition ${
                        on ? 'border-brand bg-brand text-white' : 'border-border-strong bg-surface'
                      }`}
                    >
                      {on && <Check size={12} />}
                    </span>
                    {column.label}
                  </button>
                )
              })}
            </div>
          )))}

          {onReset && (
            <>
              <div role="separator" className="my-1 border-t border-border" />
              <button
                type="button"
                onClick={() => {
                  onReset()
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-sm text-ink-2 transition hover:bg-surface-2"
              >
                Reset to default
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
