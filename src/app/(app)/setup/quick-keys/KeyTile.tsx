'use client'

import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CategoryTile, Icons, toneForId } from '@/components/ui'
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

  return (
    <div
      ref={(node) => {
        setDragRef(node)
        setDropRef(node)
      }}
      className="relative"
    >
      {/* The insert caret. A line between tiles rather than sliding them apart:
          tiles that move while a finger is over them is how a drop lands one slot
          from where it was aimed. */}
      {intent === 'before' && <Caret side="left" />}
      {intent === 'after' && <Caret side="right" />}

      <button
        type="button"
        data-kit-ok
        {...attributes}
        {...listeners}
        onClick={onSelect}
        aria-pressed={selected}
        className={`relative flex size-24 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-card border-2 bg-surface px-1 text-center shadow-card transition ${
          intent === 'into'
            ? 'border-brand ring-2 ring-brand'
            : selected
              ? 'border-ink'
              : 'border-border'
        } ${dragging || isDragging ? 'opacity-40' : ''} ${
          keyRow.isHidden ? 'opacity-50 grayscale' : ''
        }`}
      >
        <CategoryTile
          icon={
            art ? (
              <img src={quickKeyArtSrc(art.file)} alt="" className="h-6 w-6" />
            ) : (
              <Glyph size={18} />
            )
          }
          tone={art ? art.tone : toneForId(keyRow.id)}
        />
        <span className="line-clamp-2 text-[11px] font-semibold leading-tight text-ink">
          {label}
        </span>

        {/* A folder says how many are inside, because a group with nothing in it is
            worth noticing and an empty one looks identical otherwise. */}
        {isGroup && (
          <span className="absolute right-1 top-1 rounded-pill bg-surface-2 px-1.5 text-[10px] font-bold text-muted">
            {memberCount}
          </span>
        )}

        {/* Both matter to a manager reading the canvas: a key needing a PIN, and one
            put away for the season. */}
        {keyRow.requireAuth && (
          <span className="absolute left-1 top-1 text-muted">
            <Icons.KeyRound size={12} />
          </span>
        )}
        {keyRow.isHidden && (
          <span className="absolute bottom-1 left-1 text-muted">
            <Icons.Offline size={12} />
          </span>
        )}
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
