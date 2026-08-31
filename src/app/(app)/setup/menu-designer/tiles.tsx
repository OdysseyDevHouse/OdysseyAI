'use client'

import type { MouseEvent, ReactNode } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  Badge,
  Button,
  CategoryTile,
  Icons,
  ProductTile as KitTile,
  toneForId,
  toneForTileToken,
  departmentGlyph,
  productGlyph,
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

/**
 * How tall a tile stands here.
 *
 * Above SHORT_TILE_MAX (128), so the kit tile takes its TALL layout — glyph and name
 * on the top line, then the code and the price beneath. That is the arrangement the
 * till uses at its default size, and this screen's whole claim is to show what the
 * cashier will see.
 *
 * The threshold is the constraint, not a preference. Below it the kit flips to a
 * side-by-side row and DROPS the subtitle, which here carries "3 sections · 12
 * products" — the one line telling a manager how much menu sits behind a tile. A
 * first pass at 116 silently lost it on every tile.
 *
 * 136 rather than the till's 150: a manager reads this canvas whole at desk distance,
 * so the tile only has to clear the threshold, not match a counter screen.
 */
export const TILE_H = 136

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
  const tone = productTone(product)

  return (
    <div ref={setDropRef} className="relative">
      {zone === 'before' && <Caret side="before" />}
      {zone === 'after' && <Caret side="after" />}

      {/* data-kit-ok: the WRAPPER, not the tile. It carries the drag listeners, the
          keyboard affordance and the hover actions — none of which a kit component
          should learn — while the tile inside is the real `ProductTile` the till
          draws. That split is the point: this screen promises a preview of the till,
          and the only way to keep that promise is for the preview to BE the till's
          component rather than a copy of it that drifts. */}
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
        className={`group relative cursor-grab touch-manipulation select-none rounded-card transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          isDragging || dimmed ? 'opacity-40' : ''
        } ${hidden && !selected ? 'opacity-60' : ''}`}
      >
        <KitTile
          title={product.description}
          /* The barcode, as the till's own tile shows it — see CatalogPane, which
             swaps in a STOCK note there instead. It does not belong here: a manager
             arranging the menu is identifying which product a tile is, and "none on
             hand" answers a question nobody is asking at this desk.

             A variant GROUP says so instead (070). Its own barcode is usually
             blank — a grouping row is never scanned — and more to the point the
             thing a manager needs to know before placing this tile is that it
             behaves differently from its neighbours: at the till it opens a
             picker rather than ringing up, and hiding or moving it takes every
             size with it. */
          subtitle={
            product.hasVariants
              ? `${product.variantCount} ${product.variantCount === 1 ? 'variant' : 'variants'}`
              : product.barcode || product.code
          }
          /* "from R199" on a group: the figure is its cheapest member's, and a
             bare price would state as fact something that is true of one size
             and wrong for the rest. The picker quotes the exact one. */
          price={
            product.hasVariants
              ? `from ${formatMoney(product.price)}`
              : formatMoney(product.price)
          }
          /* The product's own icon when a manager has uploaded one, so the tile a
             cashier will actually press is what shows here. It sits ON the tone rather
             than replacing it, so a transparent glyph keeps its background.

             The KIT's helper, which is what the till itself calls — this screen
             promises a preview of the till, and two copies of the same ternary is
             exactly how that promise gets broken without anyone noticing. */
          icon={productGlyph(product.id, product.imageIcon)}
          tone={tone}
          edge={tone}
          tileHeight={TILE_H}
          selected={selected}
          /* No onClick: the wrapper above owns the gesture, because a drag has to be
             told apart from a tap and only the wrapper carries the drag listeners. The
             tile is a drawing here, and giving it a handler of its own would put two
             click targets on one tile. */
        />

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
  const tone = toneForTileToken(department.color) ?? toneForId(department.id)

  return (
    <div ref={setDropRef} className="relative">
      {zone === 'before' && <Caret side="before" />}
      {zone === 'after' && <Caret side="after" />}

      {/* data-kit-ok: the wrapper only — see the note on ProductTile above. */}
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
        className={`group relative cursor-grab touch-manipulation select-none rounded-card transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          isDragging || dimmed ? 'opacity-40' : ''
        } ${hidden ? 'opacity-60' : ''} ${
          receiving || springing ? 'ring-2 ring-brand' : ''
        }`}
      >
        <KitTile
          title={department.name}
          /* "3 sections · 12 products", where the till would show a code. Both answer
             "which one is this" — at the counter by identifying the product, here by
             saying how much menu is behind the tile, which is what a manager is
             deciding about when they arrange one. */
          subtitle={detail}
          /* The department's till picture where the shop has set one — the same
             call the rail and the catalogue grid make. Without it this screen drew
             a tag glyph where the till draws a photograph, which is the preview
             disagreeing with the thing it is previewing. */
          icon={departmentGlyph(department.id, department.posImageId, 20)}
          tone={tone}
          edge={tone}
          /* The affordance the hand-rolled tile never had: on the till a department
             tile promises another screen, and this one opens a level too. Drawn only
             where the promise is kept — see `chevron` on the kit tile. */
          chevron
          tileHeight={TILE_H}
          selected={receiving || springing}
        />

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
    /* The kit's DASHED tile — the same way-out skin the till's catalogue draws as the
       first cell of every department grid, and the same one the tables screen gives its
       new-table opener. The wrapper exists only to carry the drop ref and the ring,
       because a droppable needs a node and a kit component does not forward one. */
    <div
      ref={setNodeRef}
      className={`rounded-card transition ${receiving || springing ? 'ring-2 ring-brand' : ''}`}
    >
      <KitTile
        title="Back"
        subtitle={receiving ? 'Move up to here' : label}
        icon={<Icons.Reverse size={20} />}
        dashed
        tileHeight={TILE_H}
        onClick={onClick}
      />
    </div>
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
