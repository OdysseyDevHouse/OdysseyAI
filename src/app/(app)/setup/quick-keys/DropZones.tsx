'use client'

import { useDroppable } from '@dnd-kit/core'
import { Icons } from '@/components/ui'

/**
 * The two drop targets that are not keys.
 *
 * ── WHY THESE ARE NOT TILES ───────────────────────────────────────────────
 *
 * A `KeyTile` is draggable AND droppable, and answers "before / after / into" from
 * geometry. Neither of these means any of those things: the Back tile has exactly one
 * outcome and so does the append zone. Splitting them out keeps `KeyTile`'s thirds
 * arithmetic from having to special-case two shapes that never reorder.
 */

/**
 * Back — and the only way to take a key OUT of a group.
 *
 * The canvas has promised this in its header comment and its card description since it
 * was written, and until now there was nothing to aim at: the move handler only ever
 * produced before/after/into, so a key filed into a folder could be freed only by
 * deleting the folder. `moveQuickKey` has always accepted `parentId: null`.
 *
 * It is a drop target and a button at once. Dropping promotes; clicking navigates —
 * the same tile doing the same thing by two routes, which is why it is one control
 * rather than a tile beside a link.
 */
export function BackTile({
  label,
  active,
  onClick,
}: {
  /** The bar being returned to, so the tile says where Back goes. */
  label: string
  /** True while a drag is over it — the drop would promote the key. */
  active: boolean
  onClick: () => void
}) {
  const { setNodeRef } = useDroppable({ id: 'quick-key-out', data: { out: true } })

  return (
    <button
      ref={setNodeRef}
      type="button"
      data-kit-ok
      onClick={onClick}
      className={`flex size-24 flex-col items-center justify-center gap-1.5 rounded-card border-2 border-dashed px-1 text-center transition ${
        active
          ? 'border-brand bg-brand-soft text-brand-ink'
          : 'border-border bg-surface-2 text-muted hover:border-border-strong hover:text-ink'
      }`}
    >
      <Icons.Reverse size={20} />
      <span className="line-clamp-2 text-[11px] font-semibold leading-tight">
        {active ? 'Take it out' : `Back to ${label}`}
      </span>
    </button>
  )
}

/**
 * The gap after the last tile — drop here to append.
 *
 * Without it the only way to send a key to the end of a long bar is to aim at the
 * right-hand third of the final tile, which is a 30px target at the end of a drag that
 * has already crossed the screen. This is the rest of the row.
 *
 * Rendered only DURING a drag. A permanent dashed box on a settled canvas reads as an
 * empty slot a shop ought to fill, and there is no such thing here — keys are added
 * from the rail, not by tapping a hole in the grid.
 */
export function AppendZone({ active }: { active: boolean }) {
  const { setNodeRef } = useDroppable({ id: 'quick-key-append', data: { append: true } })

  return (
    <div
      ref={setNodeRef}
      data-kit-ok
      aria-hidden
      className={`flex h-24 min-w-24 flex-1 items-center justify-center rounded-card border-2 border-dashed text-[11px] font-semibold transition ${
        active
          ? 'border-brand bg-brand-soft text-brand-ink'
          : 'border-border text-faint'
      }`}
    >
      {active ? 'Put it last' : ''}
    </div>
  )
}
