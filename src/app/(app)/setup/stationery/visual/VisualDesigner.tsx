'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { Badge, Callout, Card, CardBody, CardHeader } from '@/components/ui'
import {
  DOC_BLOCK_CATALOG,
  MAX_BLOCKS,
  blockKindsFor,
  newBlock,
  serialiseSpec,
  type DocBlockKind,
  type DocumentSpec,
} from '@/lib/stationery/blocks'
import { previewBlocksAction } from '../actions'
import BlockPalette, { PALETTE_PREFIX, paletteKind } from './BlockPalette'
import DocumentCanvas, { gapIndex } from './DocumentCanvas'

/**
 * The visual stationery designer.
 *
 * ── EVERY DND DECISION HERE WAS LEARNED ELSEWHERE ─────────────────────────
 *
 * The sensor triple, the fixed DndContext id, the cheap DragOverlay and the
 * collision strategy all come from the storefront page builder, which found
 * each of them the hard way. They are copied deliberately rather than
 * rediscovered:
 *
 *   FIXED CONTEXT ID — dnd-kit derives its aria ids from a module-level
 *   counter that the server restarts at 0 on every render while the browser
 *   carries on. Without a fixed id the whole screen reports a hydration
 *   mismatch.
 *
 *   COLLISION PER DRAG SOURCE — `closestCorners` always returns something, so a
 *   palette tile carried back to the palette and released still "landed" on a
 *   far-away gap and got added anyway. A NEW block therefore uses
 *   `pointerWithin`, which can return nothing, so a drag can be abandoned.
 *
 *   A CHEAP OVERLAY — a label chip, never a clone of the block. Cloning a live
 *   preview of a line table every frame is what makes a canvas feel slow.
 */

/** Where a drag can be abandoned, and where it cannot. */
const collisionStrategy: CollisionDetection = (args) =>
  String(args.active.id).startsWith(PALETTE_PREFIX) ? pointerWithin(args) : closestCorners(args)

const HISTORY_LIMIT = 50

export default function VisualDesigner({
  docType,
  spec,
  onChange,
}: {
  docType: string
  spec: DocumentSpec
  onChange: (next: DocumentSpec) => void
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const placingKind = paletteKind(dragging)
  const placing = placingKind !== null

  const blocks = spec.blocks
  const atLimit = blocks.length >= MAX_BLOCKS
  const used = useMemo(() => new Set(blocks.map((b) => b.kind)), [blocks])
  const kinds = useMemo(() => blockKindsFor(docType), [docType])

  /* ── the rendered page ─────────────────────────────────────────────────── */

  const [blockHtml, setBlockHtml] = useState<Record<string, string>>({})
  const [label, setLabel] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])

  /*
   * Debounced, with the answer dropped if another request went out while it was
   * in flight — otherwise a slow render of an old design lands after a fast
   * render of a new one and the canvas shows the wrong page.
   */
  const seq = useRef(0)
  const refresh = useCallback(
    (s: DocumentSpec) => {
      const mine = ++seq.current
      previewBlocksAction({ docType, spec: serialiseSpec(s) })
        .then((res) => {
          if (mine !== seq.current) return
          if (!res.ok) {
            setWarnings([res.error])
            return
          }
          setBlockHtml(res.blocks)
          setLabel(res.label)
          setWarnings(res.warnings)
        })
        .catch(() => {
          if (mine === seq.current) setWarnings(['The preview could not be rendered.'])
        })
    },
    [docType],
  )

  useEffect(() => {
    const t = setTimeout(() => refresh(spec), 300)
    return () => clearTimeout(t)
  }, [spec, refresh])

  /* ── editing ───────────────────────────────────────────────────────────── */

  /*
   * One mutation funnel, so undo has a single place to record from and no edit
   * can slip past it. The storefront builder's `commit`, minus the redo stack —
   * this screen is small enough that Ctrl+Z is the whole ask.
   */
  const past = useRef<DocumentSpec[]>([])
  const commit = useCallback(
    (next: DocumentSpec) => {
      past.current = [...past.current.slice(-(HISTORY_LIMIT - 1)), spec]
      onChange(next)
    },
    [spec, onChange],
  )

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (prev) onChange(prev)
  }, [onChange])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
      // A field-level undo inside an input must still work.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      undo()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [undo])

  const insert = useCallback(
    (kind: DocBlockKind, index: number) => {
      if (blocks.length >= MAX_BLOCKS) return
      const block = newBlock(kind, defaultsFor(kind))
      const next = [...blocks]
      next.splice(index, 0, block)
      commit({ version: 1, blocks: next })
      setSelectedId(block.id)
    },
    [blocks, commit],
  )

  const remove = useCallback(
    (id: string) => {
      commit({ version: 1, blocks: blocks.filter((b) => b.id !== id) })
      if (selectedId === id) setSelectedId(null)
    },
    [blocks, commit, selectedId],
  )

  /** A splice, not a swap: moving one block must not displace another. */
  const move = useCallback(
    (from: number, to: number) => {
      if (from === to) return
      const next = [...blocks]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      commit({ version: 1, blocks: next })
    },
    [blocks, commit],
  )

  /* ── drag ──────────────────────────────────────────────────────────────── */

  function handleStart(e: DragStartEvent) {
    setDragging(String(e.active.id))
    setOver(null)
  }

  function handleEnd(e: DragEndEvent) {
    const active = String(e.active.id)
    const target = e.over ? String(e.over.id) : null
    setDragging(null)
    setOver(null)
    if (!target) return

    const kind = paletteKind(active)
    const gap = gapIndex(target)

    if (kind) {
      // A new block. Only a gap is a legal landing place — dropping onto an
      // existing block would have to guess before or after, and a guess here
      // puts the letterhead in the middle of the totals.
      if (gap !== null) insert(kind, gap)
      return
    }

    const from = blocks.findIndex((b) => b.id === active)
    if (from === -1) return

    if (gap !== null) {
      // A gap index counts positions in the CURRENT array, so a block moving
      // DOWN passes its own slot on the way.
      move(from, gap > from ? gap - 1 : gap)
      return
    }

    const to = blocks.findIndex((b) => b.id === target)
    if (to !== -1) move(from, to)
  }

  const draggedLabel = placingKind
    ? `Add ${DOC_BLOCK_CATALOG[placingKind].label}`
    : (blocks.find((b) => b.id === dragging)?.kind &&
        DOC_BLOCK_CATALOG[blocks.find((b) => b.id === dragging)!.kind].label) ||
      ''

  return (
    <DndContext
      id="stationery-designer"
      sensors={sensors}
      collisionDetection={collisionStrategy}
      onDragStart={handleStart}
      onDragOver={(e) => setOver(e.over ? String(e.over.id) : null)}
      onDragEnd={handleEnd}
      onDragCancel={() => {
        // Both, or an overlay is left portalled over the canvas eating clicks.
        setDragging(null)
        setOver(null)
      }}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${nameOf(String(active.id), blocks)}.`,
          onDragOver: ({ over: o }) =>
            o ? `Over ${nameOf(String(o.id), blocks)}.` : 'Not over a drop point.',
          onDragEnd: ({ over: o }) =>
            o ? `Dropped on ${nameOf(String(o.id), blocks)}.` : 'Dropped with no change.',
          onDragCancel: () => 'Cancelled.',
        },
      }}
    >
      <div className="grid gap-5 xl:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-5 xl:sticky xl:top-4 xl:self-start">
          <Card>
            <CardHeader
              title="Blocks"
              description="Drag one onto the page, or click to add it at the end."
              action={
                atLimit ? <Badge tone="warning">Full</Badge> : undefined
              }
            />
            <CardBody className="max-h-[32rem] overflow-y-auto">
              <BlockPalette
                kinds={kinds}
                used={used}
                atLimit={atLimit}
                onAdd={(k) => insert(k, blocks.length)}
              />
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="The page"
            description={label || 'Rendered with your own data.'}
          />
          <CardBody>
            {warnings.length > 0 && (
              <Callout tone="warning" className="mb-4">
                <ul className="list-disc pl-5">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <DocumentCanvas
              spec={spec}
              blockHtml={blockHtml}
              selectedId={selectedId}
              dragging={dragging !== null}
              placing={placing}
              over={over}
              atLimit={atLimit}
              onSelect={setSelectedId}
              onRemove={remove}
            />
          </CardBody>
        </Card>
      </div>

      {/* A label, never a clone — see the header. */}
      <DragOverlay>
        {dragging ? (
          <div className="rounded-card bg-brand px-3 py-2 text-sm font-medium text-white shadow-pop">
            {draggedLabel}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

/** What a drag id is called, for the screen-reader announcements. */
function nameOf(id: string, blocks: DocumentSpec['blocks']): string {
  const kind = paletteKind(id)
  if (kind) return DOC_BLOCK_CATALOG[kind].label
  const gap = gapIndex(id)
  if (gap !== null) return `position ${gap + 1}`
  const block = blocks.find((b) => b.id === id)
  return block ? DOC_BLOCK_CATALOG[block.kind].label : 'the page'
}

/**
 * A new block of one kind, with enough in it to be worth looking at.
 *
 * A blank line table would render as nothing, and a designer who drags one in
 * and sees an empty box has been given a puzzle rather than a document.
 */
function defaultsFor(kind: DocBlockKind) {
  switch (kind) {
    case 'lineTable':
      return {
        columns: [
          { token: 'line.description', heading: 'Item' },
          { token: 'line.qty', heading: 'Qty', align: 'right' as const },
        ],
      }
    case 'text':
      return { text: 'Your wording here.' }
    case 'partyBlock':
      return { title: 'TO', tokens: [] }
    case 'detailList':
      return { rows: [] }
    default:
      return {}
  }
}
