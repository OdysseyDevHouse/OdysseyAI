'use client'

import { useDraggable } from '@dnd-kit/core'
import { Icons } from '@/components/ui'
import { SECTION_HINT, SECTION_LABEL, type SectionKind } from '@/lib/storefrontModel'

/**
 * Every kind of section, as something you can pick up.
 *
 * ── WHY A PALETTE AND NOT A MENU ─────────────────────────────────────────
 *
 * "Add a section" was a dropdown, and a dropdown can only add at ONE place —
 * whichever the button decided, which was the bottom of the page. So the
 * sequence for "a rotating banner, third from the top" was: add it to the
 * bottom, scroll down to find it, drag it the length of the page, scroll back
 * up. Every part of that except the first is the tool getting in the way.
 *
 * A palette says what exists without being opened, and — because a tile is a
 * thing you can hold rather than a line you can click — it carries the position
 * with it. You choose WHAT and WHERE in one gesture.
 *
 * ── THE TILES ARE ALSO THE DOCUMENTATION ─────────────────────────────────
 *
 * Each carries its hint. `SECTION_HINT` already had a sentence for every kind
 * for the inspector's header, and it answers exactly the question a menu of
 * bare names left hanging: "Picture beside words" is a guess until something
 * says it is a picture on one side and your words on the other.
 */

/**
 * The face of each kind.
 *
 * Written as a full literal map rather than picked by rule — and every entry
 * spelled out even where two share a glyph, because a `??` fallback is how a
 * new section kind ends up shipping with a generic square nobody notices.
 */
const KIND_ICON: Record<SectionKind, keyof typeof Icons> = {
  hero: 'Sparkles',
  banner: 'Picture',
  carousel: 'Pictures',
  split: 'SplitPanes',
  categories: 'LayoutGrid',
  products: 'Package',
  recent: 'History',
  reviews: 'Star',
  countdown: 'CalendarClock',
  cards: 'Boxes',
  text: 'AlignLeft',
  richtext: 'FileText',
  signup: 'Mail',
  testimonial: 'MessageSquare',
  logos: 'Shapes',
  video: 'Play',
  map: 'Pin',
  divider: 'Minus',
  spacer: 'StackedBands',
}

/** The id prefix that tells a drop handler this came from the palette. */
export const PALETTE_PREFIX = 'palette:'

/** The kind a palette drag is carrying, or null if the drag is a section. */
export function paletteKind(id: string | null): SectionKind | null {
  if (!id || !id.startsWith(PALETTE_PREFIX)) return null
  return id.slice(PALETTE_PREFIX.length) as SectionKind
}

export default function SectionPalette({
  kinds,
  atLimit,
  onAdd,
}: {
  kinds: readonly SectionKind[]
  atLimit: boolean
  /** Click-to-add, for when the target is the end of the page anyway. */
  onAdd: (kind: SectionKind) => void
}) {
  if (atLimit) {
    return (
      <p className="text-sm text-muted">
        This page is full. Remove a section before adding another.
      </p>
    )
  }

  return (
    <>
      <p className="mb-3 text-sm text-muted">
        Drag one onto the page where you want it — or click to put it at the bottom.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {kinds.map((kind) => (
          <PaletteTile key={kind} kind={kind} onAdd={() => onAdd(kind)} />
        ))}
      </div>
    </>
  )
}

function PaletteTile({ kind, onAdd }: { kind: SectionKind; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${PALETTE_PREFIX}${kind}`,
  })

  const Icon = Icons[KIND_ICON[kind]]

  /*
   * No `transform` applied, deliberately — unlike a sortable section, which
   * moves under the cursor.
   *
   * The tile is a SOURCE, not the thing being moved: what travels to the canvas
   * is a new section, and the palette should still be sitting there, intact,
   * when the drag ends. Translating the tile would drag the menu itself out of
   * the panel and leave a hole where it was. The DragOverlay draws what is in
   * flight; this stays put and merely dims.
   */
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-kit-ok
      type="button"
      onClick={onAdd}
      title={SECTION_HINT[kind]}
      className={`flex cursor-grab flex-col items-start gap-1 rounded-control border border-border bg-surface px-3 py-2.5 text-left transition hover:border-brand hover:bg-brand-soft active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      {/* `w-full` and `min-w-0` on both: without them the flex row sizes itself
          to the label's full width and the longest name ("Countdown to a
          deadline") pushes straight out through the tile's right edge instead
          of truncating inside it. */}
      <span className="flex w-full min-w-0 items-center gap-2">
        <Icon size={15} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {SECTION_LABEL[kind]}
        </span>
      </span>
      {/* Two lines at most, then clipped. The full sentence is the title
          attribute — a tile that grows to fit its longest hint would make the
          grid a ragged column of different heights. */}
      <span className="line-clamp-2 w-full min-w-0 text-xs text-muted">{SECTION_HINT[kind]}</span>
    </button>
  )
}
