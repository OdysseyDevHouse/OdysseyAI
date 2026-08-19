'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Callout, Card, CardBody, CardHeader, Icons } from '@/components/ui'
import {
  MAX_SLIP_BLOCKS,
  SLIP_DEFAULT,
  SLIP_BLOCK_INFO,
  SLIP_BLOCK_KINDS,
  serialiseSlip,
  type SlipBlock,
  type SlipBlockKind,
  type SlipSpec,
} from '@/lib/stationery/slip'
import { previewSlipBlocksAction } from './actions'
import SlipCanvas from './SlipCanvas'
import SlipInspector from './SlipInspector'
import SlipPalette from './SlipPalette'
import SlipDragGhost from './SlipDragGhost'
import { useEditHistory } from '@/lib/useEditHistory'

/**
 * The till slip's designer.
 *
 * ── CLICK THE SLIP, DRAG THE SLIP ─────────────────────────────────────────
 *
 * It was a list of seventeen blocks with their settings beside them, which
 * worked and read as a form. Changing the business name to centred meant finding
 * "Business name" in the list and reading across; seeing what that did meant
 * looking at a preview somewhere else on the screen.
 *
 * Now the slip IS the editor. Click the business name on it and its three
 * settings appear; drag it and it moves. The same move the A4 documents made,
 * with the geometry a thermal head actually has.
 *
 * ── ONE COLUMN, NOT A REDUCED CANVAS ──────────────────────────────────────
 *
 * A slip has no x and no y. 80mm of paper goes through the head one line at a
 * time, so what comes before what is the only question, and dragging up and down
 * is the complete answer rather than a simplified one. See SlipCanvas.
 *
 * ── THE MODEL DID NOT CHANGE ──────────────────────────────────────────────
 *
 * Still an ordered list of blocks, still compiling to both ESC/POS and HTML from
 * one spec so the two prints cannot disagree. This is a new way to edit it, not
 * a new thing to store — every design saved by the old editor opens here.
 */
export default function SlipDesigner({
  spec,
  onChange,
}: {
  spec: SlipSpec
  onChange: (next: SlipSpec) => void
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [html, setHtml] = useState<string[]>([])
  const [label, setLabel] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])

  const blocks = spec.blocks
  const atLimit = blocks.length >= MAX_SLIP_BLOCKS

  /*
   * Undo and redo, in memory only — see lib/useEditHistory. A designer moving
   * lines around wants "put that back" over the next few seconds, not a record
   * of last Tuesday, and persisting it would raise three real questions in
   * exchange for a feature nobody asked for.
   */
  const history = useEditHistory(spec, onChange)

  /*
   * Debounced, with a stale answer dropped — the same guard the A4 designer
   * needs: a slow render of an old design landing after a fast render of a new
   * one shows the wrong slip.
   */
  const seq = useRef(0)
  const refresh = useCallback((s: SlipSpec) => {
    const mine = ++seq.current
    previewSlipBlocksAction({ spec: serialiseSlip(s) })
      .then((res) => {
        if (mine !== seq.current) return
        if (!res.ok) {
          setWarnings([res.error])
          return
        }
        setHtml(res.blocks)
        setLabel(res.label)
        setWarnings(res.warnings)
      })
      .catch(() => {
        if (mine === seq.current) setWarnings(['The preview could not be rendered.'])
      })
  }, [])

  /*
   * ── KEYED ON THE CONTENT, NOT THE OBJECT ────────────────────────────
   *
   * The effect used to depend on `spec` itself, and a caller passing a fresh
   * object literal each render — which is exactly what an inline
   * `?? { version: 1, blocks: [] }` does — made it refire without end. The
   * preview action was called hundreds of times, and any one of those failing
   * left "The preview could not be rendered" on screen.
   *
   * The serialised spec IS the request, so keying on it is both the correct
   * dependency and free: an identical design asks for nothing new however many
   * times it is handed over.
   */
  const key = serialiseSlip(spec)

  useEffect(() => {
    /*
     * NOTHING TO PREVIEW YET.
     *
     * A slip with no blocks is the state between opening the screen and a design
     * being loaded, not a design somebody made. Asking the server about it costs
     * a request and answers with five validation complaints — "a till slip must
     * show TAX INVOICE", and so on — which would flash up as errors before the
     * real design had even arrived.
     */
    if (blocks.length === 0) {
      setHtml([])
      setWarnings([])
      return
    }
    const t = setTimeout(() => refresh(spec), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh, blocks.length])

  /*
   * ── EVERY EDIT GOES THROUGH HERE ───────────────────────────────────────
   *
   * Undo records from one place, so no change can slip past it. An edit that
   * called onChange directly would leave the stack describing a past that never
   * happened, and undo would then jump somewhere the designer never was — worse
   * than having none, because they would trust it.
   */
  const set = (next: SlipBlock[]) => history.commit({ version: 1, blocks: next })

  const patch = (i: number, changes: Partial<SlipBlock>) =>
    set(blocks.map((b, j) => (j === i ? { ...b, ...changes } : b)))

  /** Move the block at `from` so it ends up at `to`. */
  const reorder = (from: number, to: number) => {
    const next = [...blocks]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    set(next)
    // The selection follows the block, not the position: a shop that has just
    // moved something is still working on that thing.
    setSelected(to)
  }

  const remove = (i: number) => {
    set(blocks.filter((_, j) => j !== i))
    setSelected(null)
  }

  /** Put a new line in at a position. */
  const insert = (kind: SlipBlockKind, at: number) => {
    if (atLimit) return
    const next = [...blocks]
    next.splice(at, 0, { kind })
    set(next)
    setSelected(at)
  }

  /*
   * A plain CLICK on a palette tile, for anyone not dragging — it lands at the
   * end, which is the only honest reading of a gesture that named no position.
   * Dragging is how you say where.
   */
  const add = (kind: SlipBlockKind) => insert(kind, blocks.length)

  /*
   * ── A LINE CARRIED IN FROM THE PALETTE ─────────────────────────────────
   *
   * The tile starts the gesture and the canvas finishes it: the canvas already
   * answers "which gap is the pointer over" for a line being moved, and asking
   * that question twice is how two answers start to disagree.
   *
   * Pointer capture is taken on the WINDOW rather than on the tile, because the
   * pointer has to travel from the palette to the paper and a capture held by
   * the tile would keep every move event to itself.
   */
  const [adding, setAdding] = useState<{ kind: SlipBlockKind; label: string } | null>(null)

  /*
   * The cursor stays a closed hand for the whole journey — over the palette, the
   * gap between the panels, and the paper alike. On the BODY, because the
   * pointer crosses elements that know nothing about the drag and an arrow over
   * any of them reads as "nothing is happening" at the moment something is.
   *
   * DERIVED FROM `adding`, not set inside the handler. Setting it on pointerdown
   * and clearing it in a child's unmount put the two halves in different
   * lifetimes, and StrictMode's double-invoke cleared it a millisecond after it
   * was set — so in development the grabbing cursor never appeared at all.
   */
  useEffect(() => {
    if (!adding) return
    document.body.style.cursor = 'grabbing'
    return () => {
      document.body.style.cursor = ''
    }
  }, [adding])

  const pickUp = (kind: SlipBlockKind, e: React.PointerEvent) => {
    e.preventDefault()
    setAdding({ kind, label: SLIP_BLOCK_INFO[kind].label })

    const end = () => {
      setAdding(null)
      window.removeEventListener('pointerup', end)
    }
    /*
     * Cleared on the next pointerup WHEREVER it happens. A drop on the slip is
     * handled by the canvas, which fires first; this is what stops a line
     * released over the palette or the page from being carried for ever.
     */
    window.addEventListener('pointerup', end)
  }

  /* Blocks that may appear more than once — a rule, a blank line, a paragraph.
     The rest are offered only while they are not already on the slip. */
  const REPEATABLE = new Set<SlipBlockKind>(['rule', 'feed', 'text'])
  const used = new Set(blocks.map((b) => b.kind))
  const offered = SLIP_BLOCK_KINDS.filter((k) => REPEATABLE.has(k) || !used.has(k))

  return (
    <div className="grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-5">
        <SlipInspector
          block={selected === null ? null : (blocks[selected] ?? null)}
          index={selected ?? 0}
          count={blocks.length}
          onChange={(changes) => {
            if (selected !== null) patch(selected, changes)
          }}
          onRemove={() => {
            if (selected !== null) remove(selected)
          }}
          onMove={(to) => {
            if (selected !== null && to >= 0 && to < blocks.length) reorder(selected, to)
          }}
        />

        <Card>
          <CardHeader
            title="Lines you can add"
            description="Drag one onto the slip where you want it."
            action={atLimit ? <Badge tone="warning">Full</Badge> : undefined}
          />
          <CardBody className="max-h-[26rem] overflow-y-auto">
            <SlipPalette
              offered={offered}
              atLimit={atLimit}
              carrying={adding?.kind ?? null}
              onPickUp={pickUp}
              onAdd={add}
            />
            <p className="mt-3 text-xs text-muted">
              {blocks.length} of {MAX_SLIP_BLOCKS} lines
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="The slip"
          description={label || 'A sample sale, on 80mm paper.'}
          action={
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Undo"
                title="Undo"
                disabled={!history.canUndo}
                onClick={history.undo}
              >
                <Icons.Undo aria-hidden className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Redo"
                title="Redo"
                disabled={!history.canRedo}
                onClick={history.redo}
              >
                <Icons.Redo aria-hidden className="h-4 w-4" />
              </Button>
              {/*
                Reset CLEARS the history rather than recording itself as a step.
                Undoing back past a reset would land in a design the shop had
                deliberately thrown away, which is not what "undo" means to
                anyone — and the shipped layout is always one click away again.
              */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onChange(SLIP_DEFAULT)
                  history.clear()
                  setSelected(null)
                }}
              >
                Reset to standard
              </Button>
            </div>
          }
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
          <p className="mb-3 text-xs text-muted">
            Click a line to change how it prints. Drag it up or down to move it — a slip
            prints one line at a time, so that is the whole layout.
          </p>
          <SlipCanvas
            spec={spec}
            html={html}
            selected={selected}
            onSelect={setSelected}
            onReorder={reorder}
            adding={adding}
            onDrop={(at) => {
              if (adding) insert(adding.kind, at)
              setAdding(null)
            }}
            onCancelAdd={() => setAdding(null)}
          />
        </CardBody>
      </Card>

      {/* The line under the cursor, for as long as it is in the air. */}
      {adding && <SlipDragGhost label={adding.label} />}
    </div>
  )
}
