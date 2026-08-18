'use client'

import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button, Checkbox, Icons, Input, NumberInput, Select } from '@/components/ui'
import { MAX_COLUMNS, type ColumnSpec } from '@/lib/stationery/blocks'

/**
 * The line table's columns.
 *
 * This is the control the whole visual designer was asked for: show or hide a
 * column, drag it left or right, rename its heading, set its width.
 *
 * ── THE TOKEN DECIDES THE VALUE, THE HEADING IS ONLY WORDS ────────────────
 *
 * A column stores both, and they are edited separately on purpose. Renaming
 * "Unit price" to "Rate" must not carry any risk of the column then showing
 * something else — the token is what the catalog resolves and formats, and the
 * heading is text on a page.
 *
 * ── A COLUMN NOBODY MAY SEE IS NOT OFFERED ────────────────────────────────
 *
 * `available` is already filtered by the caller's capabilities, so a designer
 * without products.cost is never offered a cost column. It would render blank
 * for them, and a control whose only effect is invisible is worse than no
 * control.
 */

/** dnd-kit ids have to be strings and unique; a token is both. */
const rowId = (token: string) => `col:${token}`

function ColumnRow({
  col,
  index,
  count,
  onChange,
  onRemove,
}: {
  col: ColumnSpec
  index: number
  count: number
  onChange: (patch: Partial<ColumnSpec>) => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rowId(col.token),
  })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-control border border-border px-2.5 py-2 ${
        isDragging ? 'z-10 opacity-60' : ''
      }`}
    >
      {/*
       * Two rows, not one.
       *
       * Six controls on a single line collapsed the heading field to 26px in a
       * side rail — which is the field a shop actually came here to use. The
       * heading gets its own line with the handle and the delete; alignment and
       * width sit underneath, where they are narrow by nature.
       */}
      <div className="flex items-center gap-2">
        {/* Spread first so our own label wins — dnd-kit's says "draggable item". */}
        <span
          {...attributes}
          {...listeners}
          role="button"
          tabIndex={0}
          aria-label={`Move ${col.heading || col.token}`}
          className="shrink-0 cursor-grab text-faint hover:text-muted"
          data-kit-ok
        >
          <Icons.DragHandle aria-hidden className="h-4 w-4" />
        </span>

        <Input
          aria-label="Column heading"
          className="min-w-0 flex-1"
          value={col.heading}
          placeholder="Heading"
          onChange={(e) => onChange({ heading: e.target.value })}
        />

        <Button
          size="sm"
          variant="danger-ghost"
          iconOnly
          aria-label={`Remove the ${col.heading || col.token} column`}
          onClick={onRemove}
          disabled={count <= 1}
        >
          <Icons.Trash aria-hidden className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-1.5 flex items-center gap-2 pl-6">
        <Select
          aria-label="Alignment"
          className="w-24"
          value={col.align ?? 'left'}
          onChange={(e) => onChange({ align: e.target.value as ColumnSpec['align'] })}
        >
          <option value="left">Left</option>
          <option value="right">Right</option>
        </Select>

        {/* Blank means "share what is left", which is the sane default and why
            this is not a required field. */}
        <NumberInput
          aria-label="Width, as a percentage"
          className="w-20"
          value={col.width ?? ''}
          placeholder="auto"
          min={1}
          max={100}
          onChange={(e) => {
            const n = Number(e.target.value)
            onChange({ width: Number.isFinite(n) && n > 0 ? n : undefined })
          }}
        />

        <span className="min-w-0 truncate text-xs text-faint">
          {`{${col.token}}`}
        </span>
      </div>
    </li>
  )
}

export default function ColumnEditor({
  columns,
  available,
  onChange,
}: {
  columns: ColumnSpec[]
  /** Every line field this caller may use, with its catalog label. */
  available: { key: string; label: string }[]
  onChange: (next: ColumnSpec[]) => void
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const chosen = new Set(columns.map((c) => c.token))
  const spare = available.filter((a) => !chosen.has(a.key))

  function handleEnd(e: DragEndEvent) {
    const from = columns.findIndex((c) => rowId(c.token) === String(e.active.id))
    const to = columns.findIndex((c) => rowId(c.token) === String(e.over?.id ?? ''))
    if (from === -1 || to === -1 || from === to) return
    const next = [...columns]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Its own context, not the page's: these rows reorder among themselves
          and must never be a drop target for a block being dragged around the
          document. */}
      <DndContext
        id="stationery-columns"
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragEnd={handleEnd}
      >
        <SortableContext
          items={columns.map((c) => rowId(c.token))}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-1.5">
            {columns.map((c, i) => (
              <ColumnRow
                key={c.token}
                col={c}
                index={i}
                count={columns.length}
                onChange={(patch) =>
                  onChange(columns.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                }
                onRemove={() => onChange(columns.filter((_, j) => j !== i))}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {columns.length === 0 && (
        <p className="text-sm text-muted">
          A table with no columns prints nothing. Add at least one.
        </p>
      )}

      {spare.length > 0 && columns.length < MAX_COLUMNS && (
        <Select
          aria-label="Add a column"
          value=""
          onChange={(e) => {
            const key = e.target.value
            if (!key) return
            const def = available.find((a) => a.key === key)
            onChange([
              ...columns,
              {
                token: key,
                // The catalog's label is the honest starting point; renaming it
                // is the next thing a shop does, and now can.
                heading: def?.label ?? key,
                // Money and quantity read down a column, so they start right.
                align: /cost|price|total|amount|qty|discount|vat/i.test(key) ? 'right' : 'left',
              },
            ])
            e.target.value = ''
          }}
        >
          <option value="">Add a column…</option>
          {spare.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </Select>
      )}

      <p className="text-xs text-muted">
        {columns.length} of {MAX_COLUMNS} columns. Leave a width blank and it shares whatever
        the others do not use.
      </p>
    </div>
  )
}
