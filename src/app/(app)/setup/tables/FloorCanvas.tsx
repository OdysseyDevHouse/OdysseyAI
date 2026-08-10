'use client'

import { useMemo, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core'
import { Button, Icons, Badge } from '@/components/ui'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import type { PosTable } from '@/lib/site/posTables'

/**
 * The floor, as a shape a manager drags.
 *
 * ── ROOM UNITS IN, PERCENTAGES OUT ────────────────────────────────────────
 *
 * Everything stored is in room units; everything rendered is a percentage of the canvas.
 * That one conversion is the whole reason a layout built on a laptop reads on a counter
 * screen — and it is why the canvas measures itself rather than assuming a size: a drag
 * delta arrives from dnd-kit in PIXELS and has to be divided by the live pixel width to
 * become units. Hard-coding a scale here is how a plan ends up correct on exactly one
 * monitor.
 *
 * ── WHY NOT useSortable ───────────────────────────────────────────────────
 *
 * A floor plan is free positioning, not a list. `useSortable` exists to compute an index
 * from a hover, which is precisely the wrong model — there is no order here, only x and y.
 * `useDraggable` hands over a pixel delta and nothing else, which is exactly what this
 * needs. There is no droppable at all: the canvas is the only target, so a drop is
 * wherever the pointer stopped.
 *
 * ── NOTHING SAVES UNTIL SAVE ──────────────────────────────────────────────
 *
 * Every drag, resize and rotation is local state. A manager rearranging a room is
 * exploring, and a canvas that wrote each nudge to the database would turn one
 * reorganisation into forty round trips and leave a half-moved floor behind if the tab
 * closed. `savePlacements` then writes the whole room atomically.
 */

/** How fine the snap is, in room units. 1 unit ≈ 1% of a default room. */
const SNAP = 1

/** The selected table's resize/rotate step, per keypress or per button. */
const NUDGE = 1
const SIZE_STEP = 1
const ROTATE_STEP = 15

/**
 * A table's placement, as the canvas edits it.
 *
 * The same fields `PosTable` already carries — the canvas edits a LOCAL copy and only the
 * changed ones are sent on Save. A parallel type rather than `Partial<PosTable>` because
 * the half of `PosTable` that describes occupancy (documentId, state, totalIncl) has no
 * business being editable here, and a Partial would let a mis-typed spread carry it.
 */
export type Placement = Pick<
  PosTable,
  'id' | 'roomId' | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'shape'
>

export function placementOf(table: PosTable): Placement {
  return {
    id: table.id,
    roomId: table.roomId,
    x: table.x,
    y: table.y,
    width: table.width,
    height: table.height,
    rotation: table.rotation,
    shape: table.shape,
  }
}

export function FloorCanvas({
  room,
  tables,
  placements,
  features,
  selectedId,
  onSelect,
  onMove,
  onAddFeature,
  onMoveFeature,
  onDeleteFeature,
  busy,
}: {
  room: FloorRoom
  /** Every table, placed or not. The unplaced ones show in the tray below. */
  tables: PosTable[]
  placements: Map<number, Placement>
  features: FloorFeature[]
  /** `t123` for a table, `f45` for a feature. One selection across both. */
  selectedId: string | null
  onSelect: (id: string | null) => void
  onMove: (tableId: number, next: Partial<Placement>) => void
  onAddFeature: (kind: FloorFeature['kind']) => void
  onMoveFeature: (id: number, next: Partial<FloorFeature>) => void
  onDeleteFeature: (id: number) => void
  busy: boolean
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  /** Live pixel size, measured on drag start — see the docblock. */
  const scale = useRef({ w: 1, h: 1 })
  const [dragDelta, setDragDelta] = useState<{ id: string; dx: number; dy: number } | null>(null)

  const sensors = useSensors(
    /* 6px before a drag starts, so a TAP still selects. Same threshold as
       BuilderCanvas — a manager selecting a table to resize it must not move it. */
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    /* Long-press on touch, so the page still scrolls and a tap still selects. */
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )

  const placed = useMemo(
    () => tables.filter((t) => placements.get(t.id)?.roomId === room.id),
    [tables, placements, room.id],
  )
  const roomFeatures = useMemo(
    () => features.filter((f) => f.roomId === room.id),
    [features, room.id],
  )

  function measure() {
    const box = canvasRef.current?.getBoundingClientRect()
    if (box && box.width > 0) scale.current = { w: box.width, h: box.height }
  }

  /** Pixel delta → room units, using the measured canvas. */
  function toUnits(dx: number, dy: number) {
    return {
      x: (dx / scale.current.w) * room.width,
      y: (dy / scale.current.h) * room.height,
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragDelta(null)
    const id = String(event.active.id)
    const moved = toUnits(event.delta.x, event.delta.y)

    if (id.startsWith('t')) {
      const tableId = Number(id.slice(1))
      const current = placements.get(tableId)
      if (!current) return
      onMove(tableId, {
        x: snap((current.x ?? 0) + moved.x),
        y: snap((current.y ?? 0) + moved.y),
      })
      return
    }
    const featureId = Number(id.slice(1))
    const feature = roomFeatures.find((f) => f.id === featureId)
    if (!feature) return
    onMoveFeature(featureId, {
      x: snap(feature.x + moved.x),
      y: snap(feature.y + moved.y),
    })
  }

  const selected =
    selectedId?.startsWith('t') && placements.get(Number(selectedId.slice(1)))
      ? placements.get(Number(selectedId.slice(1)))!
      : null
  const selectedTable = selected ? tables.find((t) => t.id === selected.id) ?? null : null

  return (
    <DndContext
      /* FIXED, for the reason BuilderCanvas:214 documents at length — dnd-kit derives
         aria ids from a module counter that the server restarts at 0, so an unnamed
         context is a hydration mismatch on every load. */
      id="floor-canvas"
      sensors={sensors}
      onDragStart={() => measure()}
      onDragMove={(e: DragMoveEvent) =>
        setDragDelta({ id: String(e.active.id), dx: e.delta.x, dy: e.delta.y })
      }
      onDragEnd={handleDragEnd}
      /* Escape mid-drag must clear the preview, or the table renders at an offset
         nothing will ever reset. */
      onDragCancel={() => setDragDelta(null)}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${labelFor(String(active.id), tables)}.`,
          onDragOver: () => '',
          onDragEnd: ({ active }) => `${labelFor(String(active.id), tables)} moved.`,
          onDragCancel: ({ active }) =>
            `Moving ${labelFor(String(active.id), tables)} was cancelled.`,
        },
      }}
    >
      <div className="space-y-3">
        {/* ── Furniture palette ──────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">Add:</span>
          {(['wall', 'bar', 'pass', 'door', 'plant', 'text'] as const).map((kind) => (
            <Button
              key={kind}
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onAddFeature(kind)}
            >
              <Icons.Plus size={14} />
              {kind}
            </Button>
          ))}
        </div>

        {/*
          ── The room ──────────────────────────────────────────────────────
          `aspect-ratio` from the room's own dimensions, so a long verandah and a square
          dining room both render true rather than being squeezed into one shape. The
          canvas is the only drop target, so a table lands wherever the pointer stopped.
        */}
        <div
          ref={canvasRef}
          className="till-surface relative w-full overflow-hidden rounded-card border-2 border-border bg-surface-2"
          style={{ aspectRatio: `${room.width} / ${room.height}` }}
          /* A click on the floor itself clears the selection — the way out of a
             selected state without a Cancel button to find. */
          onClick={() => onSelect(null)}
        >
          {/* A faint grid, so a manager can line tables up by eye. Two gradients
              rather than an image: it scales with the canvas and needs no asset. */}
          <div
            aria-hidden
            data-kit-ok
            className="pointer-events-none absolute inset-0 opacity-[0.14]"
            style={{
              backgroundImage:
                'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
              backgroundSize: `${(10 / room.width) * 100}% ${(10 / room.height) * 100}%`,
            }}
          />

          {roomFeatures.map((feature) => (
            <FeatureShape
              key={`f${feature.id}`}
              feature={feature}
              room={room}
              selected={selectedId === `f${feature.id}`}
              delta={dragDelta?.id === `f${feature.id}` ? dragDelta : null}
              scale={scale.current}
              onSelect={() => onSelect(`f${feature.id}`)}
            />
          ))}

          {placed.map((table) => {
            const placement = placements.get(table.id)!
            return (
              <TableShape
                key={`t${table.id}`}
                table={table}
                placement={placement}
                room={room}
                selected={selectedId === `t${table.id}`}
                delta={dragDelta?.id === `t${table.id}` ? dragDelta : null}
                scale={scale.current}
                onSelect={() => onSelect(`t${table.id}`)}
              />
            )
          })}
        </div>

        {/* ── The selected thing's controls ──────────────────────────────── */}
        {selected && selectedTable && (
          <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface p-3">
            <Badge tone="brand">{selectedTable.code}</Badge>
            <Stepper
              label="Width"
              value={selected.width}
              onChange={(v) => onMove(selected.id, { width: v })}
              busy={busy}
            />
            <Stepper
              label="Height"
              value={selected.height}
              onChange={(v) => onMove(selected.id, { height: v })}
              busy={busy}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                onMove(selected.id, { rotation: (selected.rotation + ROTATE_STEP) % 360 })
              }
            >
              <Icons.RotateCw size={14} />
              {selected.rotation}°
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                onMove(selected.id, { shape: selected.shape === 'round' ? 'rect' : 'round' })
              }
            >
              {selected.shape === 'round' ? 'Round' : 'Square'}
            </Button>
            {/* Taking a table OFF the plan does not delete it — it goes back to the tray
                and keeps appearing in the sectioned grid, which is the whole fallback. */}
            <Button
              variant="danger-ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                onMove(selected.id, { roomId: null, x: null, y: null })
                onSelect(null)
              }}
            >
              <Icons.Close size={14} />
              Off the plan
            </Button>
          </div>
        )}

        {selectedId?.startsWith('f') && (
          <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface p-3">
            {(() => {
              const feature = roomFeatures.find((f) => f.id === Number(selectedId.slice(1)))
              if (!feature) return null
              return (
                <>
                  <Badge tone="neutral">{feature.kind}</Badge>
                  <Stepper
                    label="Width"
                    value={feature.width}
                    onChange={(v) => onMoveFeature(feature.id, { width: v })}
                    busy={busy}
                  />
                  <Stepper
                    label="Height"
                    value={feature.height}
                    onChange={(v) => onMoveFeature(feature.id, { height: v })}
                    busy={busy}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      onMoveFeature(feature.id, {
                        rotation: (feature.rotation + ROTATE_STEP) % 360,
                      })
                    }
                  >
                    <Icons.RotateCw size={14} />
                    {feature.rotation}°
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      onDeleteFeature(feature.id)
                      onSelect(null)
                    }}
                  >
                    <Icons.Trash size={14} />
                    Remove
                  </Button>
                </>
              )
            })()}
          </div>
        )}

        {/* ── The tray: tables not yet on the plan ───────────────────────── */}
        <UnplacedTray
          tables={tables}
          placements={placements}
          busy={busy}
          onPlace={(tableId) => {
            /*
             * CASCADED, not stacked in the middle.
             *
             * The first version dropped every table at the room's centre, so placing four
             * put four tables at identical coordinates — one visible pile a manager has to
             * drag apart before they can even see what they have. Found by looking at the
             * till screenshot, where a four-table room showed one table.
             *
             * Offset by how many are already placed, wrapping so a big room does not walk
             * tables off the far edge (the server clamps anyway, but a clamped stack in the
             * corner is the same problem moved).
             */
            const already = tables.filter(
              (t) => placements.get(t.id)?.roomId === room.id,
            ).length
            const step = 10
            const perRow = Math.max(1, Math.floor((room.width - 12) / step))
            onMove(tableId, {
              roomId: room.id,
              x: snap(6 + (already % perRow) * step),
              y: snap(6 + Math.floor(already / perRow) * step),
            })
          }}
        />
      </div>
    </DndContext>
  )
}

/* ── One table on the canvas ──────────────────────────────────────────────── */

function TableShape({
  table,
  placement,
  room,
  selected,
  delta,
  scale,
  onSelect,
}: {
  table: PosTable
  placement: Placement
  room: FloorRoom
  selected: boolean
  delta: { dx: number; dy: number } | null
  scale: { w: number; h: number }
  onSelect: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `t${table.id}` })

  /* The live preview is the DRAG DELTA in percent, applied as a transform — not a
     changed x/y. Committing position mid-drag would re-render every frame from state
     and fight dnd-kit for control of the same pixels. */
  const shiftX = delta ? (delta.dx / scale.w) * 100 : 0
  const shiftY = delta ? (delta.dy / scale.h) * 100 : 0

  return (
    <button
      ref={setNodeRef}
      type="button"
      data-kit-ok
      data-table-code={table.code}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      className={`absolute flex flex-col items-center justify-center border-2 text-center transition-shadow ${
        placement.shape === 'round' ? 'rounded-full' : 'rounded-card'
      } ${
        selected
          ? 'border-brand bg-brand-soft text-brand shadow-pop'
          : 'border-border-strong bg-surface text-ink'
      } ${isDragging ? 'z-20 opacity-90' : 'z-10'}`}
      style={{
        left: `${((placement.x ?? 0) / room.width) * 100}%`,
        top: `${((placement.y ?? 0) / room.height) * 100}%`,
        width: `${(placement.width / room.width) * 100}%`,
        height: `${(placement.height / room.height) * 100}%`,
        transform: `translate(${shiftX}%, ${shiftY}%) rotate(${placement.rotation}deg)`,
        touchAction: 'none',
      }}
    >
      <span className="text-sm font-bold leading-none">{table.code}</span>
      {table.seats > 0 && <span className="text-[10px] text-muted">{table.seats}</span>}
    </button>
  )
}

/* ── One wall / bar / door ────────────────────────────────────────────────── */

const FEATURE_SKIN: Record<FloorFeature['kind'], string> = {
  wall: 'bg-ink-2/70 border-ink-2',
  bar: 'bg-warning-soft border-warning',
  pass: 'bg-success-soft border-success',
  door: 'bg-surface border-dashed border-border-strong',
  plant: 'bg-success-soft border-success rounded-full',
  text: 'bg-transparent border-transparent',
}

function FeatureShape({
  feature,
  room,
  selected,
  delta,
  scale,
  onSelect,
}: {
  feature: FloorFeature
  room: FloorRoom
  selected: boolean
  delta: { dx: number; dy: number } | null
  scale: { w: number; h: number }
  onSelect: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `f${feature.id}` })
  const shiftX = delta ? (delta.dx / scale.w) * 100 : 0
  const shiftY = delta ? (delta.dy / scale.h) * 100 : 0

  return (
    <button
      ref={setNodeRef}
      type="button"
      data-kit-ok
      {...listeners}
      {...attributes}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      className={`absolute flex items-center justify-center border-2 text-[10px] ${
        FEATURE_SKIN[feature.kind]
      } ${selected ? 'ring-2 ring-brand' : ''} ${isDragging ? 'z-20 opacity-90' : 'z-0'}`}
      style={{
        left: `${(feature.x / room.width) * 100}%`,
        top: `${(feature.y / room.height) * 100}%`,
        width: `${(feature.width / room.width) * 100}%`,
        height: `${(feature.height / room.height) * 100}%`,
        transform: `translate(${shiftX}%, ${shiftY}%) rotate(${feature.rotation}deg)`,
        touchAction: 'none',
      }}
    >
      {feature.label}
    </button>
  )
}

/* ── The tray ─────────────────────────────────────────────────────────────── */

function UnplacedTray({
  tables,
  placements,
  busy,
  onPlace,
}: {
  tables: PosTable[]
  placements: Map<number, Placement>
  busy: boolean
  onPlace: (tableId: number) => void
}) {
  const unplaced = tables.filter((t) => t.isActive && placements.get(t.id)?.roomId == null)
  if (unplaced.length === 0) return null

  return (
    <div className="rounded-card border border-border bg-surface p-3">
      <p className="mb-2 text-sm text-muted">
        Not on the plan yet — tap to drop one into this room. These still show on the
        till&rsquo;s sectioned list, so nothing is hidden from a waiter meanwhile.
      </p>
      <div className="flex flex-wrap gap-2">
        {unplaced.map((t) => (
          <Button key={t.id} variant="secondary" size="sm" disabled={busy} onClick={() => onPlace(t.id)}>
            <Icons.Plus size={14} />
            {t.code}
          </Button>
        ))}
      </div>
    </div>
  )
}

/* ── Bits ─────────────────────────────────────────────────────────────────── */

function Stepper({
  label,
  value,
  onChange,
  busy,
}: {
  label: string
  value: number
  onChange: (next: number) => void
  busy: boolean
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-xs text-muted">{label}</span>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={`${label} smaller`}
        disabled={busy || value <= 1}
        onClick={() => onChange(Math.max(1, value - SIZE_STEP))}
      >
        <Icons.Minus size={14} />
      </Button>
      <span className="numeric w-8 text-center text-sm text-ink">{value}</span>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={`${label} bigger`}
        disabled={busy}
        onClick={() => onChange(value + SIZE_STEP)}
      >
        <Icons.Plus size={14} />
      </Button>
    </span>
  )
}

/** Rounded to the snap grid, and never negative. */
function snap(value: number): number {
  return Math.max(0, Math.round(value / SNAP) * SNAP)
}

function labelFor(id: string, tables: PosTable[]): string {
  if (id.startsWith('t')) {
    return tables.find((t) => t.id === Number(id.slice(1)))?.code ?? 'the table'
  }
  return 'the furniture'
}
