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
      /* The till's own dashed back tile, class for class — glyph beside the words on
         one row, brand/40 dashes, full grid-cell height. The designer is a preview of
         the counter screen, so its way out of a group must look like the cashier's. */
      className={`flex h-full w-full min-w-0 items-center gap-3 rounded-card border-2 border-dashed py-2 pr-3 pl-2.5 text-left transition active:scale-[0.98] ${
        active
          ? 'border-brand bg-brand-soft text-brand-ink'
          : 'border-brand/40 bg-surface text-ink hover:border-brand hover:bg-brand-soft'
      }`}
    >
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-[14px] bg-brand-soft text-brand"
      >
        <Icons.Reverse size={18} />
      </span>
      <span className="line-clamp-2 min-w-0 flex-1 text-[15px] font-semibold leading-tight">
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
      /* h-full, not a fixed height: it is a cell of the same grid the tiles sit in
         now, so the row sets its height and this fills it. */
      className={`flex h-full min-w-0 items-center justify-center rounded-card border-2 border-dashed text-[13px] font-semibold transition ${
        active
          ? 'border-brand bg-brand-soft text-brand-ink'
          : 'border-border text-faint'
      }`}
    >
      {active ? 'Put it last' : ''}
    </div>
  )
}
