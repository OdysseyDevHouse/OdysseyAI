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
  allBlocks,
  blockKindsFor,
  locate,
  newBlock,
  newRow,
  patchBlock,
  removeBlock,
  serialiseSpec,
  type DocBlock,
  type DocBlockKind,
  type DocumentSpec,
} from '@/lib/stationery/blocks'
import { previewBlocksAction } from '../actions'
import BlockPalette, { PALETTE_PREFIX, paletteKind } from './BlockPalette'
import DocumentCanvas, { GAP_PREFIX, parseGap } from './DocumentCanvas'
import BlockInspector, { type TokenChoice } from './BlockInspector'

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
 *   A CHEAP OVERLAY — a label chip, never a clone of the block. Cloning a live
 *   preview of a line table every frame is what makes a canvas feel slow.
 *
 * Collision detection is the one thing this screen had to work out for itself,
 * because it has NESTED drop targets where the builder has a flat list. See
 * `collisionStrategy`.
 */

/**
 * Where a drag may land.
 *
 * ── ONLY GAPS ARE CANDIDATES ──────────────────────────────────────────────
 *
 * Blocks are registered as sortable so they can be PICKED UP, which also makes
 * them collision candidates — and dnd-kit was offering them as drop targets.
 * `handleEnd` ignores anything that is not a gap, so every one of those was a
 * silent dead drop: the block lifted, the pointer sat on a neighbour, the
 * release did nothing and the designer got no explanation.
 *
 * They also crowded out the real ones. Filtering to gaps makes every target
 * dnd-kit names somewhere the block can actually go, which is what the
 * announcements read out — so a screen-reader user is told the truth.
 *
 * Found by driving the drag and reading those announcements back, which named
 * "the page" and "The items" as targets that could never accept a drop.
 *
 * ── AND A NEW BLOCK MUST STILL BE ABANDONABLE ─────────────────────────────
 *
 * `closestCorners` always returns something, so a palette tile carried back to
 * the palette and released would still "land" on a far-away gap and be added
 * anyway. A new block therefore uses `pointerWithin`, which can return nothing.
 */
const collisionStrategy: CollisionDetection = (args) => {
  const gapsOnly = {
    ...args,
    droppableContainers: args.droppableContainers.filter((c) =>
      String(c.id).startsWith(GAP_PREFIX),
    ),
  }
  return String(args.active.id).startsWith(PALETTE_PREFIX)
    ? pointerWithin(gapsOnly)
    : closestCorners(gapsOnly)
}

const HISTORY_LIMIT = 50

export default function VisualDesigner({
  docType,
  spec,
  tokens,
  onChange,
}: {
  docType: string
  spec: DocumentSpec
  /** Every field this caller may use. Already permission-filtered. */
  tokens: TokenChoice[]
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
  const flat = useMemo(() => allBlocks(spec), [spec])
  const atLimit = flat.length >= MAX_BLOCKS
  const used = useMemo(() => new Set(flat.map((b) => b.kind)), [flat])
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

  /**
   * Put a block into the page or into a cell, at an index.
   *
   * One function for both, because "a column of blocks" is the same shape
   * whether the column is the page or a sixth of it — the only difference is
   * which array gets spliced.
   */
  const insertAt = useCallback(
    (block: DocBlock, cellId: string | null, index: number) => {
      if (cellId === null) {
        const next = [...spec.blocks]
        next.splice(index, 0, block)
        commit({ version: 1, blocks: next })
        return
      }
      commit({
        version: 1,
        blocks: spec.blocks.map((b) => {
          if (b.kind !== 'row') return b
          return {
            ...b,
            cells: (b.cells ?? []).map((c) => {
              if (c.id !== cellId) return c
              const inner = [...c.blocks]
              inner.splice(index, 0, block)
              return { ...c, blocks: inner }
            }),
          }
        }),
      })
    },
    [spec, commit],
  )

  const insert = useCallback(
    (kind: DocBlockKind, cellId: string | null, index: number) => {
      if (allBlocks(spec).length >= MAX_BLOCKS) return
      // A row is a container for the page, not something to nest in a cell.
      if (kind === 'row' && cellId !== null) return
      const block = kind === 'row' ? newRow(2) : newBlock(kind, defaultsFor(kind))
      insertAt(block, cellId, index)
      setSelectedId(block.id)
    },
    [spec, insertAt],
  )

  const remove = useCallback(
    (id: string) => {
      commit(removeBlock(spec, id))
      if (selectedId === id) setSelectedId(null)
    },
    [spec, commit, selectedId],
  )

  const patch = useCallback(
    (id: string, changes: Partial<DocBlock>) => commit(patchBlock(spec, id, changes)),
    [spec, commit],
  )

  /**
   * Move a block to a gap, wherever both are.
   *
   * Lift then drop, rather than a splice in place: the block may be leaving one
   * cell for another, or leaving a cell for the page, and "remove it, then put
   * it where it is going" is the only version of that with one code path.
   *
   * The index correction is the same one every sortable list needs — a gap
   * counts positions in the array as it is NOW, so a block moving DOWN within
   * the same column passes its own slot on the way.
   */
  const moveTo = useCallback(
    (id: string, toCell: string | null, toIndex: number) => {
      const found = locate(spec, id)
      if (!found) return

      const sameColumn = found.cellId === toCell
      const fromIndex = sameColumn
        ? (toCell === null
            ? spec.blocks
            : (spec.blocks
                .find((b) => b.kind === 'row' && (b.cells ?? []).some((c) => c.id === toCell))
                ?.cells?.find((c) => c.id === toCell)?.blocks ?? [])
          ).findIndex((b) => b.id === id)
        : -1

      if (sameColumn && fromIndex !== -1 && toIndex > fromIndex) toIndex--
      if (sameColumn && fromIndex === toIndex) return

      const without = removeBlock(spec, id)
      const next = { ...without }
      // Re-insert into the pruned document, so the index means what it says.
      const withBlock = (() => {
        if (toCell === null) {
          const arr = [...next.blocks]
          arr.splice(toIndex, 0, found.block)
          return { version: 1 as const, blocks: arr }
        }
        return {
          version: 1 as const,
          blocks: next.blocks.map((b) => {
            if (b.kind !== 'row') return b
            return {
              ...b,
              cells: (b.cells ?? []).map((c) => {
                if (c.id !== toCell) return c
                const inner = [...c.blocks]
                inner.splice(toIndex, 0, found.block)
                return { ...c, blocks: inner }
              }),
            }
          }),
        }
      })()

      commit(withBlock)
    },
    [spec, commit],
  )

  /**
   * Nudge a block one place inside whatever column it is in.
   *
   * The keyboard path, and the quiet everyday one — dragging is for taking a
   * block somewhere else, this is for "not quite there". It stays WITHIN the
   * column deliberately: a block stepping out of a cell on its own would be a
   * surprise, and moving between columns is what dragging is for.
   */
  const nudge = useCallback(
    (id: string, by: -1 | 1) => {
      const found = locate(spec, id)
      if (!found) return

      const column =
        found.cellId === null
          ? spec.blocks
          : (spec.blocks
              .find(
                (b) => b.kind === 'row' && (b.cells ?? []).some((c) => c.id === found.cellId),
              )
              ?.cells?.find((c) => c.id === found.cellId)?.blocks ?? [])

      const from = column.findIndex((b) => b.id === id)
      const to = from + by
      if (from === -1 || to < 0 || to >= column.length) return

      // moveTo takes a GAP index, which counts positions in the array as it is
      // now — so stepping down is a gap two along, not one.
      moveTo(id, found.cellId, by === 1 ? to + 1 : to)
    },
    [spec, moveTo],
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
    const gap = parseGap(target)

    /*
     * Only a GAP is a landing place, for a new block and a moved one alike.
     *
     * Dropping onto another block would have to guess before or after, and with
     * cells in play it would also have to guess whether "onto the row" means
     * beside it or inside one of its columns. A gap says exactly where.
     */
    if (!gap) return

    if (kind) {
      insert(kind, gap.cellId, gap.index)
      return
    }

    // A row cannot go inside a cell — the model forbids it, and the drop should
    // simply not take rather than silently landing somewhere else.
    const found = locate(spec, active)
    if (!found) return
    if (found.block.kind === 'row' && gap.cellId !== null) return

    moveTo(active, gap.cellId, gap.index)
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
      {/*
       * Palette, page, inspector.
       *
       * FOUR columns of chrome around an A4 page is one too many: at 1600px the
       * paper was squeezed to about 200px and the heading fields in the column
       * editor collapsed to nothing. So the palette and the inspector share the
       * left rail — only one of them is ever being used — and the page keeps
       * the rest. It is the subject; the panels serve it.
       */}
      <div className="grid gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-5 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto [&>*]:shrink-0">
          {/* The selected block's settings come FIRST. Once a document is laid
              out, changing what a block shows is the work; adding another is
              the occasional thing. */}
          <BlockInspector
            block={selectedId ? (locate(spec, selectedId)?.block ?? null) : null}
            tokens={tokens}
            onChange={(changes) => {
              if (selectedId) patch(selectedId, changes)
            }}
          />

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
                onAdd={(k) => insert(k, null, spec.blocks.length)}
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
              onSelect={setSelectedId}
              onRemove={remove}
              onMove={nudge}
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
  const gap = parseGap(id)
  if (gap) {
    return gap.cellId
      ? `a column, position ${gap.index + 1}`
      : `position ${gap.index + 1} on the page`
  }
  const block = blocks.find((b) => b.id === id)
  // Only reached for the thing being CARRIED, since collision now offers gaps
  // alone. Naming a block here as a target would describe a drop that cannot
  // happen.
  return block ? DOC_BLOCK_CATALOG[block.kind].label : 'a block'
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
