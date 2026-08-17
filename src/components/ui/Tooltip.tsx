import type { ReactNode } from 'react'

/**
 * Tooltip — the full text of something that had to be shortened.
 *
 * ── WHY NOT `title=` ────────────────────────────────────────────────────────
 *
 * The browser's native tooltip waits about a second before appearing, renders in
 * the OS's own font and colours rather than the app's, and cannot be styled at
 * all. On a catalogue where every tile carries a clipped description, that delay
 * is the whole experience: the reader hovers, gets nothing, and moves on before
 * the text arrives. This shows immediately and wears the app's own surface.
 *
 * ── WHY CSS AND NOT STATE ───────────────────────────────────────────────────
 *
 * No `useState`, no positioning library, no `'use client'`. The panel is a
 * sibling that `group-hover` and `group-focus-within` reveal, so it costs no
 * hydration and works inside server components — which matters because the
 * things most likely to need it (hub tiles, table cells) are rendered by the
 * hundred. A JS tooltip on 85 report tiles is 85 listeners and 85 pieces of
 * state for something CSS does in one rule.
 *
 * The trade is that it cannot escape an ancestor's `overflow: hidden`, and it
 * cannot flip itself when it would leave the viewport — `side` is chosen by the
 * caller rather than measured. For a one-line clarification anchored to a tile
 * that is the right trade; a rich popover that must stay on screen wherever it
 * lands is a different component and should stay one.
 *
 * ── ACCESSIBILITY ───────────────────────────────────────────────────────────
 *
 * The panel is `aria-hidden` and the trigger carries the text as its accessible
 * name instead, so a screen reader hears it once rather than twice. Keyboard
 * users get it via `group-focus-within` when the trigger is focusable — which,
 * where this is used on a link or button, it already is.
 */
export function Tooltip({
  label,
  children,
  side = 'top',
  align = 'center',
  trigger = 'self',
  className = '',
}: {
  /** The full text. Nothing renders if this is empty — no empty bubble. */
  label: string
  /** What the reader hovers: usually the clipped text itself. */
  children: ReactNode
  side?: 'top' | 'bottom'
  align?: 'center' | 'start'
  /**
   * What has to be hovered for the panel to show.
   *
   * `self` — the wrapped text, which is what you want nearly always.
   *
   * `card` — the nearest ancestor marked `group`, used when something covers
   * this text and takes the pointer. The hub's tiles are the case: each is a
   * card with an overlay link (`after:absolute inset-0`) making the WHOLE tile
   * clickable, and that overlay sits above the description, so the text itself
   * can never receive `:hover` and a `self` tooltip silently never appears.
   * Reacting to the card's own hover is the only thing that works without
   * dismantling the overlay — and it reads better anyway, since the reader is
   * pointing at the tile they are considering.
   */
  trigger?: 'self' | 'card'
  className?: string
}) {
  if (!label) return <>{children}</>

  return (
    <span className={`group/tip relative block min-w-0 max-w-full ${className}`}>
      {children}
      <span
        role="tooltip"
        aria-hidden="true"
        className={[
          'pointer-events-none absolute z-50 w-max max-w-xs rounded-control',
          'border border-border bg-surface px-2.5 py-1.5 shadow-pop',
          'text-xs leading-snug text-ink-2 whitespace-normal text-left',
          /* Instant: no delay, and a short fade only so it does not snap.
             Opacity rather than display, because a transition needs a rendered
             box to animate — and `invisible` keeps it out of hit-testing. */
          'invisible opacity-0 transition-opacity duration-75',
          TRIGGER[trigger],
          SIDE[side],
          ALIGN[align],
        ].join(' ')}
      >
        {label}
      </span>
    </span>
  )
}

/* Full class strings, never interpolated — Tailwind scans source text, so a
   computed `mb-${n}` is not emitted and the panel would sit on top of its own
   trigger. Same reason the kit writes out EDGE_RING. */

/* `card` also keeps the self-hover rule: the two are not exclusive, and a
   reader whose pointer is on the text is hovering the card as well. Keyboard
   focus is only meaningful for the element itself, so focus-within stays on
   the wrapper in both modes. */
const TRIGGER: Record<string, string> = {
  self: 'group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100',
  card: 'group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100',
}

const SIDE: Record<string, string> = {
  top: 'bottom-full mb-1.5',
  bottom: 'top-full mt-1.5',
}

const ALIGN: Record<string, string> = {
  center: 'left-1/2 -translate-x-1/2',
  start: 'left-0',
}
