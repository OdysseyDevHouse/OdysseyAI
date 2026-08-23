'use client'

import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CategoryTile, Checkbox, EDGE_LEAD, EDGE_RING, Icons, toneForId } from '@/components/ui'
import { actionForSlug, quickKeyLabel, type QuickKeyRow } from '@/lib/quickKeys'
import { quickKeyArt, quickKeyArtSrc } from '@/lib/quickKeyArt'

/**
 * One key on the designer's canvas — draggable, and a drop target at the same time.
 *
 * ── WHY NOT `useSortable` ─────────────────────────────────────────────────
 *
 * The storefront builder next door uses it, correctly: its sections only ever reorder.
 * A sortable node cannot express "drop INTO me", and that is the whole gesture here —
 * dragging one key onto another makes a group of them. So this composes the two
 * primitives on one element: `useDraggable` to pick it up, `useDroppable` to be a
 * target.
 *
 * The cost is that reordering has to be worked out from the drop rather than handed
 * over by the sortable strategy, which is `dropIntent` in the canvas.
 *
 * ── THE OUTER THIRD REORDERS, THE MIDDLE NESTS ────────────────────────────
 *
 * A single key cannot mean both "put me beside you" and "put me inside you" without
 * splitting its surface. Which third the pointer is over is worked out by the CANVAS
 * from the drag delta and the tile's measured rect — this component only renders the
 * answer, as a caret on one side or a ring around the whole tile.
 *
 * That split is deliberate: the geometry needs the collision rects dnd-kit already
 * measures, and duplicating it per tile would mean 40 components each deciding what the
 * drag means. The tile draws; the canvas decides.
 */
export function KeyTile({
  keyRow,
  label,
  isGroup,
  memberCount,
  dragging,
  intent,
  selected,
  onSelect,
  ticked,
  selecting,
  onTick,
}: {
  keyRow: QuickKeyRow
  /** Resolved by the canvas — a product key reads its product's name. */
  label: string
  isGroup: boolean
  memberCount: number
  /** True while THIS tile is the one being dragged. */
  dragging: boolean
  /**
   * What would happen if the drag ended now: a caret on one side, or a ring for a
   * nest. Null when this tile is not the target.
   */
  intent: 'before' | 'after' | 'into' | null
  selected: boolean
  onSelect: () => void
  /** True once this key is ticked for a bulk change. */
  ticked: boolean
  /**
   * Ticking is offered on hover, and permanently once ANY key is ticked — the moment a
   * selection exists, every other tile needs an obvious way to join it, including on a
   * touchscreen where there is no hover to reveal one.
   */
  selecting: boolean
  onTick: (additive: boolean) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: `key-${keyRow.id}`, data: { keyId: keyRow.id } })

  const { setNodeRef: setDropRef } = useDroppable({
    id: `drop-${keyRow.id}`,
    data: { keyId: keyRow.id, isGroup },
  })

  const action = keyRow.kind === 'action' ? actionForSlug(keyRow.actionSlug) : null
  const Glyph = glyphFor(keyRow.icon || action?.icon || (isGroup ? 'Shapes' : 'Sparkles'))
  /* The same art, resolved the same way, as the till. A manager arranging keys must be
     looking at what the cashier will see — a canvas of flat glyphs beside a till of
     drawn icons is two screens disagreeing about the same row. */
  const art = quickKeyArt({ actionSlug: keyRow.actionSlug, icon: keyRow.icon })
  /* ONE tone per key, driving the glyph disc and the leading edge together — the
     way the product grid does it. Two different hues on one tile would read as two
     facts about it rather than as the one identifier a manager scans for. */
  const tone = art ? art.tone : toneForId(keyRow.id)

  return (
    <div
      ref={(node) => {
        setDragRef(node)
        setDropRef(node)
      }}
      className="group relative"
    >
      {/* The insert caret. A line between tiles rather than sliding them apart:
          tiles that move while a finger is over them is how a drop lands one slot
          from where it was aimed. */}
      {intent === 'before' && <Caret side="left" />}
      {intent === 'after' && <Caret side="right" />}

      {/*
        The tick, over the tile's top-left.
        A sibling of the drag button rather than a child of it: nesting an interactive
        element inside a <button> is invalid, and a click on it would start the drag
        listeners the parent carries. Stops propagation for the same reason.
        Shift-click extends a range, which is what makes "colour these eight" one
        gesture instead of eight.
      */}
      <span
        data-kit-ok
        className={`absolute -left-1 -top-1 z-10 transition ${
          ticked || selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <Checkbox
          checked={ticked}
          aria-label={`Select ${label}`}
          className="rounded-control bg-surface p-1 shadow-card"
          onClick={(e) => {
            e.stopPropagation()
            onTick(e.shiftKey)
          }}
          /* The state change is driven from onClick, which is the only handler carrying
             shiftKey. React still wants onChange on a controlled input. */
          onChange={() => {}}
        />
      </span>

      <button
        type="button"
        data-kit-ok
        {...attributes}
        {...listeners}
        onClick={onSelect}
        aria-pressed={selected}
        /* w-full as well as h-full: the wrapper is the grid cell and stretches to it,
           but a <button> is a shrink-to-fit box, so without this every key is only as
           wide as its own caption — "Undo" 124px beside "Take a payment" 199px in the
           same 247px cell. A designer previewing a till needs the tiles to be the one
           size the cashier will press. */
        className={`relative flex h-full w-full min-w-0 flex-col gap-2 overflow-hidden rounded-card border bg-surface py-3.5 pr-3.5 pl-3 text-left shadow-card transition active:scale-[0.98] ${
          /* The same three-state border ProductTile draws, in the same order and for
             the same reason: being chosen takes the brand hairline but keeps the
             leading edge, so a selected key still reads as the key it is. `into`
             outranks both — mid-drag, what the drop will do matters more than what
             was selected before it. */
          intent === 'into'
            ? `border-brand ring-2 ring-brand ${EDGE_LEAD[tone]}`
            : selected
              ? `border-brand bg-brand-soft ${EDGE_LEAD[tone]}`
              : `${EDGE_RING[tone]} ${EDGE_LEAD[tone]}`
        } border-l-4 ${dragging || isDragging ? 'opacity-40' : ''} ${
          keyRow.isHidden ? 'opacity-50 grayscale' : ''
        }`}
      >
        {/* Glyph BESIDE the label, not above it — the arrangement the product grid
            wears, and the reason ProductTile gives: the picture and the name for it
            are one label, and splitting them by a disc's height makes a scan down the
            grid read every picture first and then go back up for the words. */}
        <span className="flex min-w-0 items-center gap-2.5">
          <CategoryTile
            icon={
              art ? (
                <img src={quickKeyArtSrc(art.file)} alt="" className="h-6 w-6" />
              ) : (
                <Glyph size={18} />
              )
            }
            tone={tone}
            size="lg"
          />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {/* 15px, matching the till's own tiles rather than the back office's 14px
                body: this canvas is a preview of a counter screen, and a label that
                fits here at 11px can overflow there. */}
            <span className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-tight text-ink">
              {label}
            </span>
            {/* A folder gets the chevron the department tiles wear, because it is the
                same promise: tapping this opens something rather than doing something. */}
            {isGroup && (
              <span aria-hidden className="shrink-0 text-lg leading-none text-muted">
                ›
              </span>
            )}
          </span>
        </span>

        {/* The notes under the name, where the product grid puts its stock line and
            price. flex-1 so this block owns the remaining height and the row of
            badges sits on the tile's bottom edge — the same place on every tile,
            rather than at a height that moves with the label above it. */}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {isGroup ? (
            <span className="truncate text-[13px] text-muted">
              {memberCount} {memberCount === 1 ? 'key' : 'keys'} inside
            </span>
          ) : (
            /* What pressing it does — the SAME line the till draws under the same
               caption, from the same `hint` on the same action, at ActionTile's own
               size and colour. A manager arranging keys should not have to open each
               one to find out what it is: the designer is a preview of the counter
               screen, and the till has always explained itself here.

               line-clamp-3 like the till's, so a long hint stops rather than pushing
               the badges off a fixed-height tile. */
            action && (
              <span className="line-clamp-3 text-[13px] leading-snug text-muted">
                {action.hint}
              </span>
            )
          )}
          <span className="mt-auto flex items-center gap-2 text-muted">
            {/* Both matter to a manager reading the canvas: a key needing a PIN, and
                one put away for the season. Words rather than bare glyphs in the
                corners — there is room for them at this size, and a corner icon is
                only legible to somebody who already knows what it means. */}
            {keyRow.requireAuth && (
              <span className="flex items-center gap-1 text-[12px]">
                <Icons.KeyRound size={13} />
                PIN
              </span>
            )}
            {keyRow.isHidden && (
              <span className="flex items-center gap-1 text-[12px]">
                <Icons.Offline size={13} />
                Hidden
              </span>
            )}
          </span>
        </span>
      </button>
    </div>
  )
}

function Caret({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden
      data-kit-ok
      className={`absolute inset-y-0 w-0.5 rounded-pill bg-brand ${
        side === 'left' ? '-left-1.5' : '-right-1.5'
      }`}
    />
  )
}

/**
 * The icon a stored NAME refers to.
 *
 * Falls back to a placeholder rather than rendering nothing: a key whose icon name was
 * removed from the kit should still be pressable and still be findable on this screen so
 * somebody can give it a new one.
 */
function glyphFor(name: string) {
  const set = Icons as unknown as Record<string, typeof Icons.Sparkles>
  return set[name] ?? Icons.Sparkles
}
