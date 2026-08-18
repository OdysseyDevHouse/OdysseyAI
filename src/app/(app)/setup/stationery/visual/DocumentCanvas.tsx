'use client'

import { useEffect, useRef } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Badge, Button, Icons } from '@/components/ui'
import {
  DOC_BLOCK_CATALOG,
  type DocBlock,
  type DocumentSpec,
} from '@/lib/stationery/blocks'
import { rowsOf } from '@/lib/stationery/compile'

/**
 * The page, as a thing you drag blocks around on.
 *
 * ── THE PREVIEW IS THE CANVAS ─────────────────────────────────────────────
 *
 * What is drawn here is the SERVER's render of the real compiled document,
 * handed down as HTML — not a mock of it. The storefront builder learned this
 * one the hard way and states it plainly: a second implementation of the
 * document exists only to agree with the first, and it stops agreeing at the
 * moment somebody trusts it.
 *
 * So each block's markup is sliced out of that render by id and wrapped in the
 * selection chrome. The page a designer moves things around on is the page that
 * prints.
 *
 * ── NOT AN IFRAME ─────────────────────────────────────────────────────────
 *
 * dnd-kit's sensors bind to the document they are mounted in, so a drag that
 * began out here would go deaf the moment the pointer crossed a frame boundary.
 */

/** The id a gap answers to while a block is in flight. */
export const GAP_PREFIX = 'gap:'

export function gapIndex(id: string | null): number | null {
  if (!id || !id.startsWith(GAP_PREFIX)) return null
  const n = Number(id.slice(GAP_PREFIX.length))
  return Number.isFinite(n) ? n : null
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
  dragging,
  placing,
  over,
  atLimit,
}: {
  index: number
  /** Anything in flight, new or moved. */
  dragging: boolean
  /** Specifically a NEW block from the palette. */
  placing: boolean
  over: string | null
  atLimit: boolean
}) {
  const id = `${GAP_PREFIX}${index}`
  /*
   * Live for a MOVE as well as for a new block.
   *
   * Gated on `placing` alone at first, which meant a block being dragged had no
   * gap to land on — it lifted, and dropped back exactly where it started. The
   * page is the drop target for both gestures; only the limit differs, and only
   * for a new block, since moving one adds nothing.
   */
  const disabled = !dragging || (placing && atLimit)
  const { setNodeRef } = useDroppable({ id, disabled })

  if (placing && atLimit) return null
  const active = over === id

  return (
    <div
      ref={setNodeRef}
      className={`relative flex items-center justify-center transition-all ${
        dragging ? 'my-1 h-9' : '-my-1.5 h-3'
      }`}
    >
      {dragging && (
        <span
          className={`pointer-events-none absolute inset-x-0 flex h-full items-center justify-center rounded-control border border-dashed transition ${
            active ? 'border-brand bg-brand-soft' : 'border-border-strong bg-surface-2/40'
          }`}
        >
          <span className={`text-xs font-medium ${active ? 'text-brand-ink' : 'text-muted'}`}>
            {active ? 'Drop it here' : 'Here'}
          </span>
        </span>
      )}
    </div>
  )
}

/**
 * One block on the page, with the chrome that makes it selectable and draggable.
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
  removable,
  placing,
  onSelect,
  onRemove,
}: {
  block: DocBlock
  html: string
  selected: boolean
  removable: boolean
  placing: boolean
  onSelect: () => void
  onRemove: () => void
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
          selected
            ? { outline: '2px solid var(--color-brand)', outlineOffset: 4 }
            : undefined
        }
      >
        {/* The document itself. Inert, so the preview cannot be interacted
            with by accident — a link in a footer must not navigate away from
            the designer. */}
        <div className="pointer-events-none" dangerouslySetInnerHTML={{ __html: html }} />

        {/* Nothing to look at is still something to select — a notes block on
            an order with no notes renders empty, and a designer who cannot see
            it cannot move it. */}
        {html.trim() === '' && (
          <p className="rounded-control border border-dashed border-border-strong px-3 py-2 text-xs text-muted">
            {def.label} — nothing to show on this example document.
          </p>
        )}

        {!placing && (
          <button
            type="button"
            aria-label={`Select ${def.label}`}
            onClick={onSelect}
            className="absolute inset-0 z-[1]"
            data-kit-ok
          />
        )}

        {/* The toolbar. Above the block so it never covers the first line of
            what it labels. */}
        <div
          className={`absolute -top-3 right-2 z-[2] flex items-center gap-1 rounded-pill border border-border bg-surface px-1.5 py-0.5 shadow-card transition ${
            selected ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 hover:opacity-100'
          }`}
        >
          {/* Spread first so our own role and label win — see BlockPalette. */}
          <span
            {...attributes}
            {...listeners}
            role="button"
            tabIndex={0}
            aria-label={`Move ${def.label}`}
            className="cursor-grab px-0.5 text-faint hover:text-muted"
            data-kit-ok
          >
            <Icons.DragHandle aria-hidden className="h-3.5 w-3.5" />
          </span>
          <span className="px-1 text-xs text-muted">{def.label}</span>
          {def.required && <Badge tone="brand">Required</Badge>}
          {removable && (
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

export default function DocumentCanvas({
  spec,
  blockHtml,
  selectedId,
  dragging,
  placing,
  over,
  atLimit,
  onSelect,
  onRemove,
}: {
  spec: DocumentSpec
  /** The server's render of each block, by block id. */
  blockHtml: Record<string, string>
  selectedId: string | null
  /** Anything in flight, new or moved. */
  dragging: boolean
  placing: boolean
  over: string | null
  atLimit: boolean
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}) {
  const ids = spec.blocks.map((b) => b.id)

  /*
   * Blocks are laid out in ROWS so a left/right pair sits side by side, exactly
   * as it will print — the same grouping compile.ts does. Dragging still works
   * on the flat list underneath: `SortableContext` is given every id in order,
   * so a block can be pulled out of a pair and dropped anywhere.
   */
  const rows = rowsOf(spec.blocks)

  const removableCount = (kind: DocBlock['kind']) => !DOC_BLOCK_CATALOG[kind].required

  let flatIndex = 0

  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {/* The paper. A fixed maximum width at the proportions the document
          prints at, on the page's own surface, so what is being arranged looks
          like a sheet rather than like a form. */}
      <div className="mx-auto w-full max-w-[52rem] rounded-card border border-border bg-surface p-8">
        <InsertPoint index={0} dragging={dragging} placing={placing} over={over} atLimit={atLimit} />

        {rows.map((row) => {
          if ('full' in row) {
            const i = ++flatIndex
            return (
              <div key={row.full.id}>
                <CanvasBlock
                  block={row.full}
                  html={blockHtml[row.full.id] ?? ''}
                  selected={selectedId === row.full.id}
                  removable={removableCount(row.full.kind)}
                  placing={placing}
                  onSelect={() => onSelect(row.full.id)}
                  onRemove={() => onRemove(row.full.id)}
                />
                <InsertPoint index={i} dragging={dragging} placing={placing} over={over} atLimit={atLimit} />
              </div>
            )
          }

          // A pair. Two gaps are skipped deliberately: dropping BETWEEN a
          // left and its right would break the pair, and there is no way to
          // say "into the left half" that a designer would predict. Pull one
          // out first, then place it.
          flatIndex += 2
          const i = flatIndex
          return (
            <div key={row.left.id}>
              <div className="flex items-start justify-between gap-8">
                <div className="min-w-0 flex-1">
                  <CanvasBlock
                    block={row.left}
                    html={blockHtml[row.left.id] ?? ''}
                    selected={selectedId === row.left.id}
                    removable={removableCount(row.left.kind)}
                    placing={placing}
                    onSelect={() => onSelect(row.left.id)}
                    onRemove={() => onRemove(row.left.id)}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <CanvasBlock
                    block={row.right}
                    html={blockHtml[row.right.id] ?? ''}
                    selected={selectedId === row.right.id}
                    removable={removableCount(row.right.kind)}
                    placing={placing}
                    onSelect={() => onSelect(row.right.id)}
                    onRemove={() => onRemove(row.right.id)}
                  />
                </div>
              </div>
              <InsertPoint index={i} dragging={dragging} placing={placing} over={over} atLimit={atLimit} />
            </div>
          )
        })}
      </div>
    </SortableContext>
  )
}
