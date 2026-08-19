'use client'

import { SLIP_BLOCK_INFO, type SlipBlockKind } from '@/lib/stationery/slip'

/**
 * The lines a slip can have, as tiles you drag onto it.
 *
 * ── WHY THIS REPLACED A DROPDOWN ──────────────────────────────────────────
 *
 * Adding a line used to mean picking it from a select, and it landed under
 * whatever happened to be selected — which reads as "somewhere", because the
 * thing you were looking at when you opened the dropdown is not the thing you
 * were thinking about when you chose from it.
 *
 * A tile you pick up and put down says where it goes at the moment you decide,
 * which is the only moment that matters. The same gesture that MOVES a line now
 * adds one, so there is one thing to learn rather than two.
 *
 * ── THE DRAG IS OWNED BY THE CANVAS ───────────────────────────────────────
 *
 * These tiles only report "a drag of this kind started". SlipCanvas tracks the
 * pointer, decides which gap it is over and draws the landing strip, because it
 * already does exactly that for a line being moved — and two implementations of
 * "which gap is this" would disagree the first time either changed.
 */
export default function SlipPalette({
  offered,
  atLimit,
  carrying = null,
  onPickUp,
  onAdd,
}: {
  /** Kinds this slip may still take. A one-per-slip block already used is out. */
  offered: readonly SlipBlockKind[]
  atLimit: boolean
  /**
   * The kind currently in the air, if any. Its tile dims and gives up its
   * shadow, so the palette shows the line as LIFTED rather than still sitting
   * there while a copy of it follows the cursor.
   */
  carrying?: SlipBlockKind | null
  /** A drag began. The canvas takes it from here. */
  onPickUp: (kind: SlipBlockKind, e: React.PointerEvent) => void
  /** A plain click, for anyone not dragging. Lands at the end. */
  onAdd: (kind: SlipBlockKind) => void
}) {
  if (offered.length === 0) {
    return (
      <p className="px-1 py-2 text-sm text-muted">
        Every line this slip can have is already on it.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {offered.map((kind) => {
        const info = SLIP_BLOCK_INFO[kind]
        const held = carrying === kind
        return (
          <li key={kind}>
            <div
              role="button"
              tabIndex={atLimit ? -1 : 0}
              aria-label={`Add ${info.label}`}
              aria-disabled={atLimit}
              onPointerDown={(e) => {
                if (atLimit || e.button !== 0) return
                onPickUp(kind, e)
              }}
              onKeyDown={(e) => {
                /*
                 * The keyboard path. A drag is a pointer gesture and a keyboard
                 * has none, so Enter adds the line at the end — where a click
                 * puts it too. Reordering afterwards is alt+arrow on the canvas.
                 */
                if (atLimit) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onAdd(kind)
                }
              }}
              className={`w-full rounded-control border bg-surface px-3 py-2 text-left transition ${
                atLimit ? 'border-border opacity-50' : 'cursor-grab hover:border-border-strong'
              } ${
                held
                  ? 'border-dashed border-brand opacity-40'
                  : 'border-border'
              }`}
              data-kit-ok
            >
              <span className="block text-sm text-ink">{info.label}</span>
              <span className="block text-xs text-muted">{info.hint}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
