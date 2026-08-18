'use client'

import { useEffect, useRef } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Badge, Button, Icons } from '@/components/ui'
import {
  DOC_BLOCK_CATALOG,
  allBlocks,
  type DocBlock,
  type DocumentSpec,
  type RowCell,
} from '@/lib/stationery/blocks'
import { cellWidths } from '@/lib/stationery/compile'

/**
 * The page, as a thing you drag blocks around on.
 *
 * ── THE PREVIEW IS THE CANVAS ─────────────────────────────────────────────
 *
 * What is drawn here is the SERVER's render of the real compiled document,
 * handed down per block — not a mock of it. A second implementation of the
 * document exists only to agree with the first, and it stops agreeing at the
 * moment somebody trusts it.
 *
 * ── ONE LEVEL OF NESTING, AND ONLY ONE ────────────────────────────────────
 *
 * The page is a column of blocks; a `row` block is a strip of cells; a cell is
 * another column of blocks. That is the whole geometry. Everything here that
 * looks recursive is really two cases — the page and a cell — which is why
 * `BlockColumn` can serve both.
 *
 * ── NOT AN IFRAME ─────────────────────────────────────────────────────────
 *
 * dnd-kit's sensors bind to the document they are mounted in, so a drag that
 * began out here would go deaf the moment the pointer crossed a frame boundary.
 */

/** The id a gap answers to. `gap:` for the page, `gap:<cellId>:` inside a cell. */
export const GAP_PREFIX = 'gap:'

export function gapId(index: number, cellId: string | null): string {
  return cellId ? `${GAP_PREFIX}${cellId}:${index}` : `${GAP_PREFIX}${index}`
}

/** Where a gap drop lands: which cell (null = the page) and at what index. */
export function parseGap(id: string | null): { cellId: string | null; index: number } | null {
  if (!id || !id.startsWith(GAP_PREFIX)) return null
  const rest = id.slice(GAP_PREFIX.length)
  const split = rest.lastIndexOf(':')
  if (split === -1) {
    const n = Number(rest)
    return Number.isFinite(n) ? { cellId: null, index: n } : null
  }
  const n = Number(rest.slice(split + 1))
  return Number.isFinite(n) ? { cellId: rest.slice(0, split), index: n } : null
}

/**
 * The landing strip between two blocks.
 *
 * Invisible at rest and nearly heightless: this canvas is a preview of a
 * printed page, and a page laddered with grey dashes is not the page. The
 * moment something is picked up every gap lights up, because a designer aiming
 * a drop has to see what they are aiming at.
 */
function InsertPoint({
  index,
  cellId,
  dragging,
  over,
  /** An empty cell has nothing to sit between, so its one gap is always shown. */
  always = false,
}: {
  index: number
  cellId: string | null
  dragging: boolean
  over: string | null
  always?: boolean
}) {
  const id = gapId(index, cellId)
  const { setNodeRef } = useDroppable({ id, disabled: !dragging })

  const active = over === id
  const show = dragging || always

  return (
    <div
      ref={setNodeRef}
      className={`relative flex items-center justify-center transition-all ${
        show ? 'my-1 h-9' : '-my-1.5 h-3'
      }`}
    >
      {show && (
        <span
          className={`pointer-events-none absolute inset-x-0 flex h-full items-center justify-center rounded-control border border-dashed transition ${
            active ? 'border-brand bg-brand-soft' : 'border-border-strong bg-surface-2/40'
          }`}
        >
          <span className={`text-xs font-medium ${active ? 'text-brand-ink' : 'text-muted'}`}>
            {active ? 'Drop it here' : always && !dragging ? 'Empty' : 'Here'}
          </span>
        </span>
      )}
    </div>
  )
}

/**
 * One block, with the chrome that makes it selectable and draggable.
 *
 * The rendered document goes inside `pointer-events-none` so a click cannot
 * land on something in the preview, and an invisible full-size button sits over
 * it as the real target. Selection is an OUTLINE rather than a border, so
 * selecting a block does not shift the page under the pointer.
 */
function CanvasBlock({
  block,
  html,
  selected,
  placing,
  canMoveUp,
  canMoveDown,
  onSelect,
  onRemove,
  onMove,
  children,
}: {
  block: DocBlock
  html: string
  selected: boolean
  placing: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onSelect: () => void
  onRemove: () => void
  /** Step it one place within whatever column it is in. */
  onMove: (by: -1 | 1) => void
  /** A row draws its cells here instead of rendered markup. */
  children?: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
  })
  const def = DOC_BLOCK_CATALOG[block.kind]

  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // Never mid-drag: dnd-kit is already auto-scrolling, and a second thing
    // moving the pane fights the pointer.
    if (!selected || isDragging) return
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected, isDragging])

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative ${isDragging ? 'z-10 opacity-60' : ''}`}
    >
      <div
        ref={box}
        className="relative rounded-control"
        style={
          selected ? { outline: '2px solid var(--color-brand)', outlineOffset: 4 } : undefined
        }
      >
        {children ?? (
          <div className="pointer-events-none" dangerouslySetInnerHTML={{ __html: html }} />
        )}

        {/* Nothing to look at is still something to select — a notes block on
            an order with no notes renders empty, and a designer who cannot see
            it cannot move it. */}
        {!children && html.trim() === '' && (
          <p className="rounded-control border border-dashed border-border-strong px-3 py-2 text-xs text-muted">
            {def.label} — nothing to show on this example document.
          </p>
        )}

        {/* A row's own click target must not cover its cells, or nothing inside
            one could ever be selected. */}
        {!placing && !children && (
          <button
            type="button"
            aria-label={`Select ${def.label}`}
            onClick={onSelect}
            className="absolute inset-0 z-[1]"
            data-kit-ok
          />
        )}

        <div
          className={`absolute -top-3 right-2 z-[2] flex items-center gap-1 rounded-pill border border-border bg-surface px-1.5 py-0.5 shadow-card transition ${
            selected ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 hover:opacity-100'
          }`}
        >
          {/* Spread first so our own role and label win. */}
          <span
            {...attributes}
            {...listeners}
            role="button"
            tabIndex={0}
            aria-label={`Drag ${def.label}`}
            className="cursor-grab px-0.5 text-faint hover:text-muted"
            data-kit-ok
          >
            <Icons.DragHandle aria-hidden className="h-3.5 w-3.5" />
          </span>

          {/*
           * Up and down, beside the drag handle.
           *
           * Not a duplicate control: dragging is for moving a block somewhere
           * else, and these are for nudging it one place. They are also the
           * KEYBOARD path — dnd-kit's keyboard sensor re-runs collision
           * detection from wherever its coordinate getter puts the drag, which
           * in a page of side-by-side cells means it wanders rather than
           * stepping. Measured: five presses of Down left the overlay's `top`
           * unchanged while it oscillated between two cells.
           *
           * The repo has made this call before — setup/tender-types and the
           * slip editor both use buttons over drag for the same reason.
           */}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Move ${def.label} up`}
            disabled={!canMoveUp}
            onClick={() => onMove(-1)}
          >
            <Icons.ChevronUp aria-hidden className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={`Move ${def.label} down`}
            disabled={!canMoveDown}
            onClick={() => onMove(1)}
          >
            <Icons.ChevronDown aria-hidden className="h-3.5 w-3.5" />
          </Button>
          {/* A row's label is also how you select it, since its body belongs to
              its cells. */}
          <button
            type="button"
            onClick={onSelect}
            className="px-1 text-xs text-muted hover:text-ink"
            data-kit-ok
          >
            {def.label}
          </button>
          {def.required && <Badge tone="brand">Required</Badge>}
          {!def.required && (
            <Button
              size="sm"
              variant="danger-ghost"
              iconOnly
              aria-label={`Remove ${def.label}`}
              onClick={onRemove}
            >
              <Icons.Trash aria-hidden className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A column of blocks with a gap above each — the page, or one cell.
 *
 * One component for both, because they are the same thing at different widths.
 * The only difference a caller passes is which cell it is (null for the page),
 * and that only decides what the gap ids say.
 */
function BlockColumn({
  blocks,
  cellId,
  blockHtml,
  selectedId,
  dragging,
  placing,
  over,
  onSelect,
  onRemove,
  onMove,
  renderRow,
}: {
  blocks: DocBlock[]
  cellId: string | null
  blockHtml: Record<string, string>
  selectedId: string | null
  dragging: boolean
  placing: boolean
  over: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onMove: (id: string, by: -1 | 1) => void
  /** Only the page draws rows; a cell cannot contain one. */
  renderRow?: (block: DocBlock) => React.ReactNode
}) {
  return (
    <>
      <InsertPoint
        index={0}
        cellId={cellId}
        dragging={dragging}
        over={over}
        always={blocks.length === 0}
      />
      {blocks.map((b, i) => (
        <div key={b.id}>
          <CanvasBlock
            block={b}
            html={blockHtml[b.id] ?? ''}
            selected={selectedId === b.id}
            placing={placing}
            canMoveUp={i > 0}
            canMoveDown={i < blocks.length - 1}
            onSelect={() => onSelect(b.id)}
            onRemove={() => onRemove(b.id)}
            onMove={(by) => onMove(b.id, by)}
          >
            {b.kind === 'row' ? renderRow?.(b) : undefined}
          </CanvasBlock>
          <InsertPoint index={i + 1} cellId={cellId} dragging={dragging} over={over} />
        </div>
      ))}
    </>
  )
}

export default function DocumentCanvas({
  spec,
  blockHtml,
  selectedId,
  dragging,
  placing,
  over,
  onSelect,
  onRemove,
  onMove,
}: {
  spec: DocumentSpec
  /** The server's render of each block, by block id. */
  blockHtml: Record<string, string>
  selectedId: string | null
  /** Anything in flight, new or moved. */
  dragging: boolean
  placing: boolean
  over: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onMove: (id: string, by: -1 | 1) => void
}) {
  /*
   * Every block id, page and cells alike, in one SortableContext.
   *
   * A block can be dragged out of a cell and onto the page, or from one cell to
   * another, so they all have to be sortable siblings as far as dnd-kit is
   * concerned. Where a drop LANDS is decided by the gap it hit, not by this
   * list.
   */
  const ids = allBlocks(spec).map((b) => b.id)

  const renderRow = (row: DocBlock) => {
    const cells = row.cells ?? []
    const widths = cellWidths(cells)
    return (
      <div className="flex items-start gap-4">
        {cells.map((cell: RowCell, i: number) => (
          <div
            key={cell.id}
            style={{ width: `${widths[i].toFixed(2)}%`, minWidth: 0 }}
            className="rounded-control border border-dashed border-border/60 px-2"
          >
            <BlockColumn
              blocks={cell.blocks}
              cellId={cell.id}
              blockHtml={blockHtml}
              selectedId={selectedId}
              dragging={dragging}
              placing={placing}
              over={over}
              onSelect={onSelect}
              onRemove={onRemove}
              onMove={onMove}
            />
          </div>
        ))}
      </div>
    )
  }

  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {/* The paper. A fixed maximum width at the proportions the document
          prints at, so what is being arranged looks like a sheet. */}
      <div className="mx-auto w-full max-w-[52rem] rounded-card border border-border bg-surface p-8">
        <BlockColumn
          blocks={spec.blocks}
          cellId={null}
          blockHtml={blockHtml}
          selectedId={selectedId}
          dragging={dragging}
          placing={placing}
          over={over}
          onSelect={onSelect}
          onRemove={onRemove}
          onMove={onMove}
          renderRow={renderRow}
        />
      </div>
    </SortableContext>
  )
}
