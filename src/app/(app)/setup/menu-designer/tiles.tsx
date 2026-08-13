'use client'

import type { MouseEvent, ReactNode } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  Badge,
  Button,
  CategoryTile,
  Icons,
  toneForId,
  toneForTileToken,
  type CategoryTone,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { Department, DragData, DropData, DropZone, MenuProduct } from './types'

/**
 * The designer's canvas tiles.
 *
 * ── DRAGGABLE AND DROPPABLE ON ONE ELEMENT ─────────────────────────────────
 *
 * Not `useSortable`, for the reason KeyTile documents next door: a sortable
 * node can only express "put me beside you", and half this screen's gestures
 * are "put me INSIDE you". So each tile composes the two primitives and the
 * canvas works the meaning out from geometry.
 *
 * ── THE TILE DRAWS, THE CANVAS DECIDES ─────────────────────────────────────
 *
 * A tile renders the answer — a caret on one side, a ring around the whole
 * thing — and never computes it. Forty tiles each deciding what a drag means is
 * forty chances for two of them to disagree.
 */

/**
 * The colour a product's tile takes — the till's rule, repeated exactly.
 *
 * The colour a manager PICKED wins; otherwise the tile inherits its
 * department's, derived from the id. Stored colour is set on a handful of
 * products out of tens of thousands, so using it alone would leave a grid of
 * grey tiles with one coloured outlier — the colour would read as "this one is
 * special" rather than as a code.
 *
 * Kept identical to CatalogPane's `tone` on purpose: this screen's whole claim
 * is that it shows what the cashier will see, and a designer that tinted its
 * tiles by any other rule would be a preview of a till that does not exist.
 */
function productTone(product: MenuProduct): CategoryTone {
  return toneForTileToken(product.imageColor) ?? toneForId(product.departmentId ?? product.id)
}

/* ── shared bits ──────────────────────────────────────────────────────────── */

/**
 * The insert caret, shown in the grid gap where a drop would land.
 *
 * A line BETWEEN tiles rather than sliding them apart to open a slot: tiles
 * that move while a finger is over them is how a drop lands one place from
 * where it was aimed. Same call the quick-key canvas made.
 */
function Caret({ side }: { side: 'before' | 'after' }) {
  return (
    <span
      aria-hidden
      data-kit-ok
      className={`pointer-events-none absolute inset-y-1 z-10 w-[3px] rounded-pill bg-brand ${
        side === 'before' ? '-left-2' : '-right-2'
      }`}
    />
  )
}

/**
 * The hover actions pinned to a tile's corner.
 *
 * Hidden until hover (or focus, so they stay reachable by tab) for the reason
 * odyssey-craft gives about tables: a visible button on every tile is fifty
 * buttons competing with the thing you came to look at. A tile that is HIDDEN
 * from the till keeps its actions on screen — that is a state worth noticing.
 */
function TileActions({ children, pinned }: { children: ReactNode; pinned: boolean }) {
  return (
    <span
      className={`absolute right-1.5 top-1.5 z-10 flex gap-1 transition ${
        pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
      }`}
    >
      {children}
    </span>
  )
}

/** A tile's corner button. Stops the pointer reaching the drag listeners. */
function TileAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <span onPointerDown={(e) => e.stopPropagation()}>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={label}
        title={label}
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          onClick()
        }}
        className="size-7 bg-surface shadow-card"
      >
        {children}
      </Button>
    </span>
  )
}

/** The "not on the till" marker, shared by both tile kinds. */
function HiddenChip() {
  return (
    <span className="flex h-7 items-center gap-1 rounded-control border border-border bg-surface-2 px-1.5 text-xs font-medium text-muted">
      <Icons.Offline size={12} />
      Hidden
    </span>
  )
}

/* ── product tile ─────────────────────────────────────────────────────────── */

export function ProductTile({
  product,
  dragId,
  fromTray,
  selected,
  dimmed,
  zone,
  canEdit,
  onClick,
  onEdit,
  onToggleVisible,
}: {
  product: MenuProduct
  /** "product-<id>" on the canvas, "tray-<id>" in the tray. */
  dragId: string
  fromTray: boolean
  selected: boolean
  /** Part of the active drag — drawn as the ghost it left behind. */
  dimmed: boolean
  zone: DropZone | null
  canEdit: boolean
  onClick: (e: MouseEvent) => void
  onEdit: () => void
  onToggleVisible: (on: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: { drag: { kind: 'product', productId: product.id, fromTray } satisfies DragData },
    disabled: !canEdit,
  })

  /* Tray tiles are draggable but NOT droppable: the tray has no order to land
     in, so letting a tile there absorb the drop would swallow drags meant for
     the tray body underneath it. */
  const { setNodeRef: setDropRef } = useDroppable({
    id: dragId,
    data: { drop: { kind: 'product-tile', productId: product.id } satisfies DropData },
    disabled: fromTray,
  })

  const hidden = !product.visibleInPos

  return (
    <div ref={setDropRef} className="relative">
      {zone === 'before' && <Caret side="before" />}
      {zone === 'after' && <Caret side="after" />}

      {/* data-kit-ok: a draggable tile carrying its own hover actions. A kit
          Button cannot hold nested controls, and no variant should learn to. */}
      <div
        data-kit-ok
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-label={product.description}
        aria-pressed={selected}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick(e as unknown as MouseEvent)
          }
        }}
        className={`group relative flex h-full min-h-[104px] cursor-grab touch-manipulation select-none flex-col justify-between gap-2 rounded-card border bg-surface p-3 text-left shadow-card transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          isDragging || dimmed ? 'opacity-40' : ''
        } ${hidden && !selected ? 'opacity-60' : ''} ${
          selected ? 'border-brand ring-2 ring-brand' : 'border-border hover:border-border-strong'
        }`}
      >
        <TileActions pinned={hidden}>
          {hidden && <HiddenChip />}
          {canEdit && (
            <>
              <TileAction
                label={hidden ? 'Show on the till' : 'Hide from the till'}
                onClick={() => onToggleVisible(hidden)}
              >
                {hidden ? <Icons.Online size={14} /> : <Icons.Offline size={14} />}
              </TileAction>
              <TileAction label="Edit tile" onClick={onEdit}>
                <Icons.Pencil size={14} />
              </TileAction>
            </>
          )}
        </TileActions>

        <span className="flex items-start gap-2 pr-1">
          {/* The same disc the till draws, with the same tone — and the
              product's own icon inside it when a manager has uploaded one, so
              the tile a cashier will actually press is what shows here. The
              icon sits ON the tone rather than replacing it, so a transparent
              glyph keeps its background (TillTilePanel makes the same call). */}
          <CategoryTile
            tone={productTone(product)}
            icon={
              product.imageIcon ? (
                <img
                  src={`/api/product-icon/${product.id}`}
                  alt=""
                  className="size-full object-contain p-0.5"
                />
              ) : (
                <Icons.Package size={18} />
              )
            }
          />
          <span className="line-clamp-2 text-sm font-semibold leading-tight text-ink">
            {product.description}
          </span>
        </span>

        <span>
          <span className="block truncate text-xs text-muted">
            {product.barcode || product.code}
          </span>
          <span className="numeric text-[15px] font-bold text-ink">
            {formatMoney(product.price)}
          </span>
        </span>
      </div>
    </div>
  )
}

/* ── department tile ──────────────────────────────────────────────────────── */

export function DepartmentTile({
  department,
  dragId,
  detail,
  zone,
  dimmed,
  springing,
  canEdit,
  onOpen,
  onEdit,
  onToggleVisible,
}: {
  department: Department
  dragId: string
  /** "3 sections · 12 products" — resolved by the canvas, which has the counts. */
  detail: string
  zone: DropZone | null
  dimmed: boolean
  /** Held long enough that the drag is about to spring this open. */
  springing: boolean
  canEdit: boolean
  onOpen: () => void
  onEdit: () => void
  onToggleVisible: (on: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: { drag: { kind: 'department', departmentId: department.id } satisfies DragData },
    disabled: !canEdit,
  })

  const { setNodeRef: setDropRef } = useDroppable({
    id: dragId,
    data: { drop: { kind: 'department-tile', departmentId: department.id } satisfies DropData },
  })

  const hidden = !department.isActive
  const receiving = zone === 'onto'

  return (
    <div ref={setDropRef} className="relative">
      {zone === 'before' && <Caret side="before" />}
      {zone === 'after' && <Caret side="after" />}

      {/* data-kit-ok: see the note on ProductTile above. */}
      <div
        data-kit-ok
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-label={`Open ${department.name}`}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          }
        }}
        className={`group relative flex min-h-[104px] cursor-grab touch-manipulation select-none flex-col justify-between gap-2 rounded-card border bg-surface p-3 text-left shadow-card transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          isDragging || dimmed ? 'opacity-40' : ''
        } ${hidden ? 'opacity-60' : ''} ${
          receiving || springing
            ? 'border-brand ring-2 ring-brand'
            : 'border-border hover:border-border-strong'
        }`}
      >
        <TileActions pinned={hidden}>
          {hidden && <HiddenChip />}
          {canEdit && (
            <>
              <TileAction
                label={hidden ? 'Show on the till' : 'Hide from the till'}
                onClick={() => onToggleVisible(hidden)}
              >
                {hidden ? <Icons.Online size={14} /> : <Icons.Offline size={14} />}
              </TileAction>
              <TileAction label="Edit department" onClick={onEdit}>
                <Icons.Pencil size={14} />
              </TileAction>
            </>
          )}
        </TileActions>

        {/* The till's department tile: a Tag in a tinted disc, toned by the
            colour a manager picked and otherwise derived from the id — the same
            two lines CatalogPane's department rail draws. */}
        <CategoryTile
          tone={toneForTileToken(department.color) ?? toneForId(department.id)}
          icon={<Icons.Tag size={18} />}
        />

        <span>
          <span className="line-clamp-2 pr-6 text-sm font-semibold leading-tight text-ink">
            {department.name}
          </span>
          <span className="mt-0.5 block text-xs text-muted">{detail}</span>
        </span>

        {/* Says what the release will do, on the tile it will do it to. */}
        {receiving && (
          <span className="pointer-events-none absolute inset-x-2 bottom-2 rounded-control bg-brand px-2 py-1 text-center text-xs font-semibold text-white">
            Move here
          </span>
        )}
      </div>
    </div>
  )
}

/* ── back tile ────────────────────────────────────────────────────────────── */

/**
 * Up one level — and a drop target for it.
 *
 * Dropping onto Back files the drag into the PARENT of what is being browsed,
 * which is how a product gets out of a department it was dragged into by
 * mistake without navigating away first.
 */
export function BackTile({
  label,
  receiving,
  springing,
  onClick,
}: {
  label: string
  receiving: boolean
  springing: boolean
  onClick: () => void
}) {
  const { setNodeRef } = useDroppable({
    id: 'back',
    data: { drop: { kind: 'back' } satisfies DropData },
  })

  return (
    /* data-kit-ok: a drop-target tile the size of the grid's cells. A kit
       Button would be the wrong shape and could not carry the ring. */
    <button
      data-kit-ok
      ref={setNodeRef}
      type="button"
      onClick={onClick}
      className={`flex min-h-[104px] flex-col justify-between gap-2 rounded-card border-2 border-dashed bg-surface-2 p-3 text-left transition hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
        receiving || springing ? 'border-brand ring-2 ring-brand' : 'border-border'
      }`}
    >
      <span aria-hidden className="text-muted">
        <Icons.Reverse size={18} />
      </span>
      <span>
        <span className="block text-sm font-semibold text-ink">Back</span>
        <span className="block truncate text-xs text-muted">
          {receiving ? 'Move up to here' : label}
        </span>
      </span>
    </button>
  )
}

/* ── drag overlay ─────────────────────────────────────────────────────────── */

/**
 * What follows the pointer: a cheap chip, never the real tile.
 *
 * A multi-select drag shows up to three stacked cards and a count, so picking
 * up twelve products looks like twelve rather than like one.
 */
export function DragOverlayCards({
  items,
  count,
}: {
  items: { key: string; label: string; tone: CategoryTone; isDepartment: boolean }[]
  count: number
}) {
  return (
    <div className="relative w-[168px] cursor-grabbing">
      {items.map((item, i) => (
        /* data-kit-ok: the floating drag chip — a rendered shadow of a tile,
           not a control anyone can press. */
        <div
          key={item.key}
          data-kit-ok
          style={{
            transform: `translate(${i * 5}px, ${i * 5}px) rotate(${i * 1.5}deg)`,
            zIndex: items.length - i,
          }}
          className={`flex min-h-[84px] items-start gap-2 rounded-card border-2 border-brand bg-surface p-3 shadow-pop ${
            i > 0 ? 'absolute inset-0' : 'relative'
          }`}
        >
          <CategoryTile
            tone={item.tone}
            icon={item.isDepartment ? <Icons.Tag size={16} /> : <Icons.Package size={16} />}
          />
          <span className="line-clamp-2 text-sm font-semibold leading-tight text-ink">
            {item.label}
          </span>
        </div>
      ))}

      {count > 1 && (
        <span className="absolute -right-2 -top-2 z-20">
          <Badge tone="brand">{count}</Badge>
        </span>
      )}
    </div>
  )
}
