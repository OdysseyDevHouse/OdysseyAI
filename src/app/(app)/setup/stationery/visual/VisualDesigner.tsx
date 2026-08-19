'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Icons,
  Switch,
} from '@/components/ui'
import {
  DEFAULT_LOGO_HEIGHT,
  DOC_BLOCK_CATALOG,
  MAX_BLOCKS,
  blockKindsFor,
  findBlock,
  newBlock,
  patchBlock,
  removeBlock,
  serialiseSpec,
  type BandKey,
  type DocBlock,
  type DocBlockKind,
  type DocumentSpec,
} from '@/lib/stationery/blocks'
import {
  alignTo,
  distribute,
  type AlignMode,
  type DistributeMode,
} from '@/lib/site/floorGeometry'
import { useDeviceToggle } from '@/lib/useDeviceToggle'
import { previewBlocksAction } from '../actions'
import BlockPalette from './BlockPalette'
import DocumentCanvas from './DocumentCanvas'
import BlockInspector, { type TokenChoice } from './BlockInspector'

/**
 * The visual stationery designer.
 *
 * ── NO dnd-kit ON THIS SCREEN ANY MORE ────────────────────────────────────
 *
 * It used to own a DndContext, a sensor triple, a collision strategy and a drag
 * overlay — all of it copied from the storefront page builder, all of it correct
 * for an ordered list with drop targets, and none of it what a canvas needs.
 *
 * The user's verdict was that the result felt buggy, and named the symptom: two
 * landing strips appearing under one pointer. That was the model showing
 * through. A list-with-gaps has the page contributing gaps and every cell
 * contributing more, so a pointer between two blocks inside a cell is genuinely
 * over two targets, and every fix I made was a cleverer arbitration rather than
 * a better tool.
 *
 * So placement moved into DocumentCanvas on raw pointer events, and everything
 * dnd-kit was here for went with it. The column editor still uses dnd-kit, and
 * should: a column list IS an ordered list, and "which column did you drop this
 * before" is the question dnd-kit answers well.
 *
 * ── WHAT THIS FILE STILL OWNS ─────────────────────────────────────────────
 *
 * The spec, one mutation funnel with undo behind it, the preview request, and
 * the align/distribute tools. The canvas reports gestures; it stores nothing.
 */

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
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [heights, setHeights] = useState<Record<string, number>>({})

  /*
   * Whether every block shows its outline, or only the one under the pointer.
   *
   * Per device, not per site: it is a working style rather than anything about
   * the document. Laying a page out, seeing where each block ENDS is most of the
   * information — which is why it defaults ON for a screen whose whole purpose is
   * arranging blocks. Reading the finished page, the same outlines are clutter
   * over something meant to look like paper, so it switches off and stays off.
   */
  const outlines = useDeviceToggle('odyssey.stationery.outlines', true)

  const atLimit = spec.blocks.length >= MAX_BLOCKS
  const used = useMemo(() => new Set(spec.blocks.map((b) => b.kind)), [spec.blocks])
  const kinds = useMemo(() => blockKindsFor(docType), [docType])

  const selected = useMemo(
    () =>
      selectedIds
        .map((id) => findBlock(spec, id))
        .filter((b): b is DocBlock => !!b),
    [selectedIds, spec],
  )

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

  const add = useCallback(
    (kind: DocBlockKind) => {
      if (spec.blocks.length >= MAX_BLOCKS) return
      /*
       * A new block goes into the band the SELECTION is in, or the header if
       * nothing is selected. Someone laying out the footer who adds a text block
       * means it to go in the footer — dropping it at the top of the page would
       * be technically defensible and would waste their next gesture.
       *
       * newBlock places it below whatever is already there, so it never lands on
       * top of something and needs untangling before it can be used.
       */
      const band: BandKey = selected[0]?.band ?? 'header'
      // The measured heights go in, so it lands below what is there rather than
      // on top of a tall block whose top happens to be higher up.
      const block = newBlock(kind, spec, { band, ...defaultsFor(kind) }, heights)
      commit({ version: 1, blocks: [...spec.blocks, block] })
      setSelectedIds([block.id])
    },
    [spec, commit, selected, heights],
  )

  const remove = useCallback(
    (id: string) => {
      commit(removeBlock(spec, id))
      setSelectedIds((ids) => ids.filter((x) => x !== id))
    },
    [spec, commit],
  )

  const patch = useCallback(
    (id: string, changes: Partial<DocBlock>) => commit(patchBlock(spec, id, changes)),
    [spec, commit],
  )

  /** Every block a gesture moved, in one commit so undo takes it back in one. */
  const place = useCallback(
    (changes: { id: string; x: number; y: number; w: number }[]) => {
      const byId = new Map(changes.map((c) => [c.id, c]))
      commit({
        version: 1,
        blocks: spec.blocks.map((b) => {
          const c = byId.get(b.id)
          return c ? { ...b, x: c.x, y: c.y, w: c.w } : b
        }),
      })
    },
    [spec, commit],
  )

  /**
   * Align or distribute the selection.
   *
   * ── THE REFERENCE IS THE FIRST-SELECTED BLOCK ─────────────────────────
   *
   * Not the leftmost, not the widest. That is what every other design tool does,
   * and it is the only rule that lets the user DECIDE the outcome rather than
   * have it inferred: click the block you want the others to line up with, then
   * shift-click the rest.
   *
   * Heights come from the canvas's measurements, because "align their bottoms"
   * needs a height and nobody stored one. Blocks that have not been measured yet
   * are left out rather than aligned against a guess — a tool that silently
   * moved a block to the wrong place would be worse than one that did nothing.
   */
  const runTool = useCallback(
    (fn: (items: { id: string; x: number; y: number; w: number; h: number }[]) => typeof items) => {
      const items = selected
        .filter((b) => heights[b.id] !== undefined)
        .map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: heights[b.id] }))
      if (items.length < 2) return
      place(fn(items).map(({ id, x, y, w }) => ({ id, x, y, w })))
    },
    [selected, heights, place],
  )

  /* Align across bands would move a block by a distance measured in another
     band's coordinates, so the tools only offer themselves within one. */
  const oneBand = selected.length > 1 && selected.every((b) => b.band === selected[0].band)

  return (
    <div className="grid gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
      {/*
       * Palette and inspector share the left rail.
       *
       * Four columns of chrome around an A4 page is one too many: at 1600px the
       * paper was squeezed to about 200px and the column editor's heading fields
       * collapsed to nothing. Only one of the two panels is ever in use, so they
       * take turns and the page keeps the rest. It is the subject.
       */}
      <div className="flex flex-col gap-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto [&>*]:shrink-0">
        {/* The selected block's settings come FIRST. Once a document is laid out,
            changing what a block shows is the work; adding another is the
            occasional thing. */}
        <BlockInspector
          block={selected.length === 1 ? selected[0] : null}
          tokens={tokens}
          onChange={(changes) => {
            if (selected.length === 1) patch(selected[0].id, changes)
          }}
          onRemove={() => {
            if (selected.length === 1) remove(selected[0].id)
          }}
        />

        {oneBand && (
          <Card>
            <CardHeader
              title={`${selected.length} blocks`}
              description="Lined up against the first one you clicked."
            />
            <CardBody className="flex flex-col gap-3">
              <ToolRow label="Line up">
                {(
                  [
                    ['left', Icons.AlignLeft, 'Left edges'],
                    ['hcentre', Icons.AlignCenter, 'Centres'],
                    ['right', Icons.AlignRight, 'Right edges'],
                    ['top', Icons.SortAsc, 'Tops'],
                    ['vmiddle', Icons.Minus, 'Middles'],
                    ['bottom', Icons.SortDesc, 'Bottoms'],
                  ] as [AlignMode, typeof Icons.AlignLeft, string][]
                ).map(([mode, Glyph, title]) => (
                  <Button
                    key={mode}
                    variant="secondary"
                    size="sm"
                    title={title}
                    aria-label={title}
                    onClick={() => runTool((i) => alignTo(i, mode))}
                  >
                    <Glyph aria-hidden className="h-4 w-4" />
                  </Button>
                ))}
              </ToolRow>

              {selected.length > 2 && (
                <ToolRow label="Space evenly">
                  {(
                    [
                      ['horizontal', 'Across'],
                      ['vertical', 'Down'],
                    ] as [DistributeMode, string][]
                  ).map(([mode, title]) => (
                    <Button
                      key={mode}
                      variant="secondary"
                      size="sm"
                      onClick={() => runTool((i) => distribute(i, mode))}
                    >
                      {title}
                    </Button>
                  ))}
                </ToolRow>
              )}
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Blocks"
            description="Click to add one, then drag it where you want it."
            action={atLimit ? <Badge tone="warning">Full</Badge> : undefined}
          />
          <CardBody className="max-h-[32rem] overflow-y-auto">
            <BlockPalette kinds={kinds} used={used} atLimit={atLimit} onAdd={add} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="The page"
          description={label || 'Rendered with your own data.'}
          action={
            <Switch
              checked={outlines.on}
              onChange={outlines.setOn}
              label="Outlines"
              hint="Show where every block starts and ends."
            />
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
            Drag a block anywhere. It lines up with its neighbours and with the page as you
            go. Shift-click to pick up more than one; arrow keys nudge.
          </p>
          <DocumentCanvas
            spec={spec}
            html={blockHtml}
            selectedIds={selectedIds}
            outlined={outlines.on}
            onSelectionChange={setSelectedIds}
            onCommit={place}
            onHeights={setHeights}
          />
        </CardBody>
      </Card>
    </div>
  )
}

function ToolRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

/**
 * A new block of one kind, with enough in it to be worth looking at.
 *
 * A blank line table would render as nothing, and a designer who adds one and
 * sees an empty box has been given a puzzle rather than a document.
 */
function defaultsFor(kind: DocBlockKind): Partial<DocBlock> {
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
    case 'logo':
      // A height from the start, so a logo dragged in is visible rather than a
      // block whose contents are waiting on a number nobody has been asked for.
      return { logoHeight: DEFAULT_LOGO_HEIGHT }
    default:
      return {}
  }
}
