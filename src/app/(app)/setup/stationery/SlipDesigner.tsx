'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Callout, Card, CardBody, CardHeader, Select } from '@/components/ui'
import {
  MAX_SLIP_BLOCKS,
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

  const set = (next: SlipBlock[]) => onChange({ version: 1, blocks: next })

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

  const add = (kind: SlipBlockKind) => {
    if (atLimit) return
    /*
     * A new block lands AFTER the selected one rather than at the end, because
     * "put a line under this" is what a shop clicking a block and then adding
     * one means. With nothing selected it goes at the end, which is the only
     * sensible reading of no context.
     */
    const at = selected === null ? blocks.length : selected + 1
    const next = [...blocks]
    next.splice(at, 0, { kind })
    set(next)
    setSelected(at)
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
            title="Add a line"
            description="It lands under whatever you have selected."
            action={atLimit ? <Badge tone="warning">Full</Badge> : undefined}
          />
          <CardBody>
            <Select
              aria-label="Add a block"
              className="w-full"
              value=""
              disabled={atLimit}
              onChange={(e) => {
                if (e.target.value) add(e.target.value as SlipBlockKind)
              }}
            >
              <option value="">Choose what to add…</option>
              {offered.map((k) => (
                <option key={k} value={k}>
                  {SLIP_BLOCK_INFO[k].label}
                </option>
              ))}
            </Select>
            <p className="mt-2 text-xs text-muted">
              {blocks.length} of {MAX_SLIP_BLOCKS} lines
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="The slip" description={label || 'A sample sale, on 80mm paper.'} />
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
          />
        </CardBody>
      </Card>
    </div>
  )
}
